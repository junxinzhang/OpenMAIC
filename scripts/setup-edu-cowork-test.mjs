process.on('uncaughtException',error=>{console.error('Sandbox verification failed',error.name,error.code??'',error.statusCode??'',('raw' in error)?'Stripe request failed':error.message);process.exit(1);});
import Stripe from 'stripe';
import { readFile,writeFile,chmod } from 'node:fs/promises';
import { parseEnv } from 'node:util';
if(!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'))throw new Error('This script requires a Stripe test key');
const stripe=new Stripe(process.env.STRIPE_SECRET_KEY,{maxNetworkRetries:2});
const plans=[];
for(const [id,name,amount,credits] of [['plus','Plus',2000,5000],['pro','Pro',10000,25000],['max','Max',20000,100000]]){
 const product=await stripe.products.create({name:`Zaokit AI Edu ${name} (Test)`,metadata:{app:'zaokit-edu',catalog:'three_tier_v1',plan:id}},{idempotencyKey:`edu-cowork-v1-test-product-${id}`});
 const price=await stripe.prices.create({product:product.id,currency:'usd',unit_amount:amount,recurring:{interval:'month'},metadata:{app:'zaokit-edu',catalog:'three_tier_v1',plan:id}},{idempotencyKey:`edu-cowork-v1-test-price-${id}`});
 plans.push({id,name,amount,credits,currency:'usd',priceId:price.id});
}
const portal=await stripe.billingPortal.configurations.create({business_profile:{headline:'Zaokit AI Edu 测试订阅管理'},features:{invoice_history:{enabled:true},payment_method_update:{enabled:true},subscription_cancel:{enabled:true,mode:'at_period_end'},subscription_update:{enabled:false}},metadata:{app:'zaokit-edu',purpose:'cowork-policy-test'}},{idempotencyKey:'edu-cowork-v1-test-portal'});
const base=parseEnv(await readFile((process.argv[2] || '.env.local'),'utf8'));
const settings={...base,DATABASE_URL:'postgresql://jason@127.0.0.1:55432/edu_cowork_billing_test',EDU_AUTH_ENABLED:'true',EDU_PUBLIC_ORIGIN:'http://localhost:3216',EDU_BILLING_POLICY:'cowork_v1',EDU_WALLET_ENABLED:'true',EDU_BILLING_ENABLED:'true',EDU_BILLING_MODE:'test',EDU_BILLING_PLANS:JSON.stringify(plans),STRIPE_PORTAL_CONFIGURATION_ID:portal.id,OPENMAIC_AGENT_RUNTIME_ENABLED:'false',NEXT_PUBLIC_PERSISTENCE:'1',NEXT_PUBLIC_PERSISTENCE_TOKEN:''};
delete settings.EDU_BILLING_ACTION_COSTS;
await writeFile('.env.cowork-test',Object.entries(settings).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');await chmod('.env.cowork-test',0o600);
console.log('Three Edu-only test plans and portal prepared; private test environment saved.');
