process.on('uncaughtException',error=>{console.error('Sandbox verification failed',error.name,error.code??'',error.statusCode??'',('raw' in error)?'Stripe request failed':error.message);process.exit(1);});
import Stripe from 'stripe';
import { Pool } from 'pg';
import { createHmac } from 'node:crypto';
import { writeFile,chmod } from 'node:fs/promises';
process.loadEnvFile('.env.cowork-test');
if(!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'))throw new Error('Sandbox only');
const base='http://localhost:3216', email='delivered@resend.dev';
let cookie='';
async function api(path,body){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Origin:base,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw new Error(`Edu test request failed: ${path} ${r.status} ${value.error??''}`);return {value,headers:r.headers};}
const started=Date.now();const challenge=(await api('/api/v1/auth/login/email',{email})).value;
const resendKey=process.env.AUTH_RESEND_KEY||process.env.RESEND_API_KEY;
async function mail(path){const r=await fetch('https://api.resend.com/'+path,{headers:{Authorization:'Bearer '+resendKey}});if(!r.ok)throw new Error('Cannot read test verification email');return r.json();}
let code;
for(let i=0;i<10&&!code;i++){
 const list=await mail('emails?limit=20');
 const found=list.data.find(x=>x.to?.includes(email)&&x.subject==='登录 Zaokit AI Edu'&&Date.parse(x.created_at)>=started-3000);
 if(found){const detail=await mail('emails/'+found.id);if(detail.text?.includes(base))code=/验证码[：:]\s*(\d{6})/.exec(detail.text)?.[1];}
 if(!code)await new Promise(r=>setTimeout(r,2000));
}
if(!code)throw new Error('Test login email not found');
const login=await api('/api/v1/auth/login/email/verify',{email,challengeId:challenge.challengeId,code,next:'/account'});
cookie=login.headers.get('set-cookie').split(';')[0];
const userId=login.value.user.id;
await writeFile('.env.cowork-session.json',JSON.stringify({cookie,userId}));await chmod('.env.cowork-session.json',0o600);
const initial=(await api('/api/billing/status')).value;
if(initial.available!==200||initial.plan!=='trial')throw new Error('Expected a fresh 200-credit trial');
console.log('Verified real email login and a single 200-credit trial.');
const job=(await api('/api/generate-classroom',{requirement:'测试课程：请仅制作一页中文普通幻灯片，用最简单的例子说明一加一等于二。页面只需要标题、两句解释和一个小结。不要测验、互动、图片、视频或语音。',enableWebSearch:false,enableImageGeneration:false,enableVideoGeneration:false,enableTTS:false,agentMode:'default'})).value;
console.log('Real classroom generation started.');
let finished;
for(let i=0;i<100;i++){
 const state=(await api('/api/generate-classroom/'+job.jobId)).value;
 if(state.status==='failed')throw new Error('Real classroom test failed');
 if(state.status==='succeeded'){finished=state;break;}
 await new Promise(r=>setTimeout(r,5000));
}
if(!finished)throw new Error('Classroom did not finish within test window');
const trial=(await api('/api/billing/status')).value;
if(!(trial.used>0&&trial.available===200-trial.used&&trial.reserved===0))throw new Error('Measured trial settlement did not match the available balance');
console.log('Verified real model usage settlement:',JSON.stringify({used:trial.used,available:trial.available,reserved:trial.reserved}));
const plans=JSON.parse(process.env.EDU_BILLING_PLANS),plus=plans.find(p=>p.id==='plus'),pro=plans.find(p=>p.id==='pro');
const checkout=(await api('/api/billing/checkout',{plan:'plus',priceId:plus.priceId,catalogVersion:'three_tier_v1'})).value;
if(!checkout.url?.startsWith('https://checkout.stripe.com/'))throw new Error('Hosted checkout missing');
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const customer=(await pool.query('SELECT customer_id FROM edu_billing_customers WHERE user_id=$1 AND livemode=false',[userId])).rows[0].customer_id;
const session=(await pool.query('SELECT session_id FROM edu_billing_checkouts WHERE user_id=$1 AND livemode=false',[userId])).rows[0].session_id;
const stripe=new Stripe(process.env.STRIPE_SECRET_KEY,{maxNetworkRetries:2});
await stripe.checkout.sessions.expire(session);
const pm=await stripe.paymentMethods.create({type:'card',card:{token:'tok_visa'}});
await stripe.paymentMethods.attach(pm.id,{customer});
await stripe.customers.update(customer,{invoice_settings:{default_payment_method:pm.id}});
const subscription=await stripe.subscriptions.create({customer,items:[{price:plus.priceId,quantity:1}],default_payment_method:pm.id,payment_behavior:'error_if_incomplete',metadata:{edu_user_id:userId}},{idempotencyKey:'edu-cowork-e2e-plus-'+userId});
async function notify(type,object){const event={id:'evt_edu_e2e_'+type+'_'+object.id,object:'event',livemode:false,type,data:{object}};const raw=JSON.stringify(event),t=Math.floor(Date.now()/1000);const signature=createHmac('sha256',process.env.STRIPE_WEBHOOK_SECRET).update(t+'.'+raw).digest('hex');const r=await fetch(base+'/api/webhooks/stripe',{method:'POST',headers:{'Content-Type':'application/json','stripe-signature':`t=${t},v1=${signature}`},body:raw});if(!r.ok)throw new Error('Signed payment notification failed: '+r.status);}
const invoiceId=typeof subscription.latest_invoice==='string'?subscription.latest_invoice:subscription.latest_invoice.id;
await notify('invoice.paid',{id:invoiceId,customer});
await notify('invoice.paid',{id:invoiceId,customer});
const paid=(await api('/api/billing/status')).value;if(paid.available!==5000||paid.invoices.length!==1)throw new Error('Plus payment was not granted exactly once');
console.log('Verified Stripe test payment, Plus 5,000 credits, and duplicate-notification protection.');
await api('/api/billing/upgrade',{plan:'pro',priceId:pro.priceId,catalogVersion:'three_tier_v1'});
const upgraded=(await api('/api/billing/status')).value;if(upgraded.available!==25000||upgraded.invoices.length!==2)throw new Error('Upgrade did not replace the allowance');
const portal=(await api('/api/billing/portal',{})).value;if(!portal.url?.startsWith('https://billing.stripe.com/'))throw new Error('Subscription portal missing');
await stripe.subscriptions.update(subscription.id,{cancel_at_period_end:true});
await notify('customer.subscription.updated',{id:subscription.id,customer});
const canceled=(await api('/api/billing/status')).value;if(canceled.available!==25000||!canceled.subscriptions[0].cancel_at_period_end)throw new Error('Period-end cancellation did not preserve paid allowance');
const result={mode:'test',emailLogin:true,trialGrant:200,trialUsed:trial.used,trialRemaining:trial.available,classroom:finished.result?.classroomId,plusCredits:paid.available,upgradeCredits:upgraded.available,paidInvoices:upgraded.invoices.length,cancelAtPeriodEnd:true,portal:true};
await writeFile('/tmp/edu-cowork-e2e-result.json',JSON.stringify(result,null,2));
console.log('PASS',JSON.stringify(result));await pool.end();
