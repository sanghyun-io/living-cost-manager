// Local static export only; all non-static requests are blocked. No provider/API writes.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { chromium } from "playwright";
import { servicePricingCopy } from "../packages/shared/dist/index.js";

const root = path.resolve("apps/web/out");
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "GET");
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    let file = path.resolve(root, "." + pathname);
    assert.ok(file === root || file.startsWith(root + path.sep));
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
    const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
    response.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
let browser;
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const copy = servicePricingCopy();
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    const unexpected = [], errors = [];
    try {
      await context.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === origin && request.method() === "GET" && !url.search &&
          (["/guide/", "/guide/faq/"].includes(url.pathname) || url.pathname.startsWith("/_next/static/"))) {
          return route.continue();
        }
        unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
        await route.abort();
      });
      const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${origin}/guide/`, { waitUntil: "networkidle" });
      const pricing = page.locator("#pricing");
      for (const text of [copy.monthly, copy.annual, copy.comparison, copy.availability, copy.tax, copy.free]) {
        assert.ok((await pricing.innerText()).includes(text), text);
      }
      assert.equal(await pricing.locator("button,input,form").count(), 0, "no fake checkout/card collection");
      for (const text of ["계약 조건이 아닙니다", "시작일이 없어 갱신일도 미정", "마케팅 수신 동의와 별도로",
        "미리 동의된 상태로 두지 않습니다", "청약철회·환불 문의를 구분", "현재 무료 기능을 제한하지 않습니다"]) {
        assert.ok((await pricing.innerText()).includes(text), `truthful billing preparation: ${text}`);
      }
      assert.equal(await pricing.getByRole("link", { name: "기존 문의 페이지", exact: true }).getAttribute("href"), "https://gamja.top/#contact");
      assert.equal(await page.locator('script[src*="portone"],script[src*="tosspayments"]').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.goto(`${origin}/guide/faq/`, { waitUntil: "networkidle" });
      const answer = page.locator("section").filter({ has: page.getByRole("heading", { name: "이용 요금과 유료 결제는 어떻게 되나요?" }) });
      for (const text of [copy.monthly, copy.annual, copy.comparison, copy.availability, copy.tax, copy.free]) {
        assert.ok((await answer.innerText()).includes(text));
      }
      const structured = await page.locator('script[type="application/ld+json"]').allTextContents();
      const faq = structured.map(text => JSON.parse(text)).find(value => value["@type"] === "FAQPage");
      assert.ok(faq, "FAQ structured data must exist");
      const pricingAnswer = faq.mainEntity.find(item => item.name === "이용 요금과 유료 결제는 어떻게 되나요?");
      assert.ok(pricingAnswer, "pricing answer must exist in FAQ structured data");
      assert.ok(pricingAnswer.acceptedAnswer.text.includes(copy.availability));
      assert.equal(await page.locator("h1").count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
      console.log(`PASS pricing ${width}px: catalog/guide/FAQ/JSON-LD consistent; planned-only; no checkout/collection/egress/errors/overflow`);
    } finally { await context.close(); }
  }
  // Price and availability are available without JavaScript as well.
  const html = await (await fetch(`${origin}/guide/`)).text();
  for (const text of [copy.monthly, copy.annual, copy.availability]) assert.ok(html.includes(text));
  console.log("PASS pricing static HTML: exact prices and unavailable status visible without JS");
} finally {
  await browser?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
