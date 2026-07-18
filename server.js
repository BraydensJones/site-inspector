// server.js
// Self-hosted headless-browser fault finder. Loads a page like a real visitor, locates forms,
// fills them with throwaway test data to see what the flow actually does, and NEVER clicks
// anything that looks like a real submit/pay/book button. All POST/PUT/DELETE network requests
// are hard-blocked at the network layer as a second safety net, so nothing can reach the
// business's backend even if a "next" button turns out to secretly submit something.

const express = require('express');
const { chromium } = require('playwright');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4001;
const AUTH_TOKEN = process.env.INSPECT_AUTH_TOKEN || '';

const TEST_VALUES = {
  name: 'Alex Test', first: 'Alex', last: 'Test',
  email: 'alex.test@example.com', phone: '5555550123',
  address: '123 Test St', city: 'Testville', state: 'NY', zip: '12345',
  message: 'Just checking pricing, no need to follow up.'
};

function guessValue(field) {
  const s = `${field.name || ''} ${field.id || ''} ${field.placeholder || ''} ${field.label || ''}`.toLowerCase();
  if (/email/.test(s)) return TEST_VALUES.email;
  if (/phone|tel/.test(s)) return TEST_VALUES.phone;
  if (/first.?name/.test(s)) return TEST_VALUES.first;
  if (/last.?name/.test(s)) return TEST_VALUES.last;
  if (/name/.test(s)) return TEST_VALUES.name;
  if (/zip|postal/.test(s)) return TEST_VALUES.zip;
  if (/city/.test(s)) return TEST_VALUES.city;
  if (/state/.test(s)) return TEST_VALUES.state;
  if (/address/.test(s)) return TEST_VALUES.address;
  if (/message|comment|note|detail/.test(s)) return TEST_VALUES.message;
  return TEST_VALUES.name;
}

const SUBMIT_WORDS = /\b(submit|book now|pay|checkout|complete|confirm|place order|schedule (?:it|now)|send request|request quote|get quote)\b/i;
const NEXT_WORDS = /\b(next|continue)\b/i;

app.post('/inspect', async (req, res) => {
  if (AUTH_TOKEN && req.headers['x-auth-token'] !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { url, maxForms = 2, maxSteps = 3, fullPage = false } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });

  let browser;
  const result = { url, forms_found: 0, interactions: [], screenshots: {}, page_text_sample: '', errors: [] };

  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    // Mobile viewport: matches how most leads will actually open the eventual outreach email.
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    });
    const page = await context.newPage();

    // Hard safety net: block every state-changing request during inspection.
    await context.route('**/*', (route) => {
      const r = route.request();
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(r.method())) return route.abort();
      return route.continue();
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }).catch(e => { result.errors.push('goto: ' + e.message); });
    await page.waitForTimeout(1000);

    // Viewport JPEG by default -- full-page PNG screenshots can trip n8n's payload size limits.
    result.screenshots.initial = (await page.screenshot({ type: 'jpeg', quality: 60, fullPage })).toString('base64');
    result.page_text_sample = (await page.innerText('body').catch(() => '')).slice(0, 6000);

    const frameTargets = [page.mainFrame()];
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      try {
        const fUrl = f.url();
        if (fUrl && /jotform|typeform|calendly|forms\.|form\.|gravityforms|wix|squarespace/i.test(fUrl)) {
          frameTargets.push(f);
        }
      } catch (e) {}
    }

    const priceRegex = /\$\s?\d/;
    const CONTACT_KEYWORDS = /contact|quote|estimate|get.?started|book(?:ing)?|schedule|free.?quote|request/i;

    async function runFormPass(frameTargetsArr, formsProcessedSoFar) {
      let formsProcessed = formsProcessedSoFar;
      const interactions = [];
      for (const frame of frameTargetsArr) {
        if (formsProcessed >= maxForms) break;
        let forms = [];
        try { forms = await frame.$$('form'); } catch (e) { continue; }
        if (!forms.length) {
          const loose = await frame.$$('input:visible, textarea:visible, select:visible').catch(() => []);
          if (loose.length >= 2) forms = [null]; // treat the page/frame itself as one pseudo-form
        }

        for (const formHandle of forms) {
          if (formsProcessed >= maxForms) break;
          formsProcessed++;
          const interaction = {
            frame_url: frame.url(), steps: [], fields_seen: [],
            price_visible_before: false, price_visible_after: false, blocked_submit_click: false
          };

          const preText = (await frame.locator('body').innerText().catch(() => '')) || '';
          interaction.price_visible_before = priceRegex.test(preText);

          for (let step = 0; step < maxSteps; step++) {
            const inputs = await (formHandle
              ? formHandle.$$('input, textarea, select')
              : frame.$$('input:visible, textarea:visible, select:visible')).catch(() => []);
            if (!inputs.length) break;

            const stepFields = [];
            for (const input of inputs) {
              try {
                const tag = await input.evaluate(el => el.tagName.toLowerCase());
                const type = await input.evaluate(el => el.type || '').catch(() => '');
                if (['submit', 'button', 'hidden', 'checkbox', 'radio', 'file'].includes(type)) continue;
                const name = await input.getAttribute('name') || '';
                const id = await input.getAttribute('id') || '';
                const placeholder = await input.getAttribute('placeholder') || '';
                let label = '';
                if (id) {
                  try {
                    const lbl = await frame.$(`label[for="${id}"]`);
                    if (lbl) label = (await lbl.innerText()).trim();
                  } catch (e) {}
                }
                const meta = { tag, type, name, id, placeholder, label };
                stepFields.push(meta);
                const val = guessValue(meta);
                if (tag === 'select') {
                  await input.selectOption({ index: 1 }).catch(() => {});
                } else {
                  await input.fill(String(val)).catch(async () => {
                    await input.type(String(val), { delay: 10 }).catch(() => {});
                  });
                }
              } catch (e) {}
            }
            for (const f of stepFields) {
              if (!interaction.fields_seen.some(x => x.name === f.name && x.label === f.label)) interaction.fields_seen.push(f);
            }
            interaction.steps.push({ step, field_count: stepFields.length });

            const buttons = await (formHandle
              ? formHandle.$$('button, input[type="submit"], a[role="button"]')
              : frame.$$('button, input[type="submit"], a[role="button"]')).catch(() => []);
            let clicked = false;
            for (const btn of buttons) {
              const text = (await btn.innerText().catch(() => '')) || (await btn.getAttribute('value').catch(() => '')) || '';
              if (SUBMIT_WORDS.test(text)) { interaction.blocked_submit_click = true; continue; }
              if (NEXT_WORDS.test(text)) {
                await btn.click({ timeout: 3000 }).catch(() => {});
                await frame.waitForTimeout(800).catch(() => {});
                clicked = true;
                break;
              }
            }
            if (!clicked) break;
          }

          const postText = (await frame.locator('body').innerText().catch(() => '')) || '';
          interaction.price_visible_after = priceRegex.test(postText);
          interactions.push(interaction);
        }
      }
      return { interactions, formsProcessed };
    }

    result.visited_urls = [page.url()];
    let pass = await runFormPass(frameTargets, 0);
    result.interactions.push(...pass.interactions);
    let formsProcessed = pass.formsProcessed;

    // Homepage had nothing -- look for a contact/quote/estimate link and follow it once.
    if (formsProcessed === 0) {
      const links = await page.$$eval('a[href]', (els) => els.map(e => ({ href: e.href, text: e.innerText || '' }))).catch(() => []);
      const origin = new URL(url).origin;
      const candidate = links.find(l => {
        try {
          const sameOrigin = new URL(l.href).origin === origin;
          return sameOrigin && (CONTACT_KEYWORDS.test(l.href) || CONTACT_KEYWORDS.test(l.text));
        } catch (e) { return false; }
      });
      if (candidate && candidate.href !== page.url()) {
        await page.goto(candidate.href, { waitUntil: 'networkidle', timeout: 15000 }).catch(e => { result.errors.push('contact_page_goto: ' + e.message); });
        await page.waitForTimeout(800);
        result.visited_urls.push(page.url());

        const newFrameTargets = [page.mainFrame()];
        for (const f of page.frames()) {
          if (f === page.mainFrame()) continue;
          try {
            const fUrl = f.url();
            if (fUrl && /jotform|typeform|calendly|forms\.|form\.|gravityforms|wix|squarespace/i.test(fUrl)) {
              newFrameTargets.push(f);
            }
          } catch (e) {}
        }
        const pass2 = await runFormPass(newFrameTargets, formsProcessed);
        result.interactions.push(...pass2.interactions);
        formsProcessed = pass2.formsProcessed;
      }
    }

    result.forms_found = formsProcessed;
    result.screenshots.after_interaction = (await page.screenshot({ type: 'jpeg', quality: 60, fullPage })).toString('base64');

  } catch (e) {
    result.errors.push('fatal: ' + e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  res.json(result);
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log('site inspector listening on ' + PORT));
