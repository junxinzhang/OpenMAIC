const baseUrl = process.env.OPENAI_BASE_URL;
const apiKey = process.env.OPENAI_API_KEY;
const models = (process.env.OPENAI_MODELS || '')
  .split(',')
  .filter(Boolean)
  .filter((model) => !/(image|video)/i.test(model));

let next = 0;
const results = [];

async function worker() {
  while (next < models.length) {
    const model = models[next++];
    try {
      const response = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: 'Reply OK',
          max_output_tokens: 8,
        }),
      });
      const text = await response.text();
      let error = null;
      if (!response.ok) {
        try {
          error = JSON.parse(text).error?.message || text;
        } catch {
          error = text;
        }
      }
      results.push({
        model,
        status: response.status,
        ok: response.ok,
        error: error?.slice(0, 100) ?? null,
      });
    } catch (error) {
      results.push({
        model,
        status: 0,
        ok: false,
        error: String(error).slice(0, 100),
      });
    }
  }
}

await Promise.all([worker(), worker(), worker()]);
results.sort((left, right) => models.indexOf(left.model) - models.indexOf(right.model));
console.log(JSON.stringify(results, null, 2));
