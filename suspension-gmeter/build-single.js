'use strict';

// 把 index.html + CSS + JS 合成一個 HTML 檔（給 Claude Artifact 或單檔分享用）。
// 用法：node suspension-gmeter/build-single.js 輸出路徑.html
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const out = process.argv[2];
if (!out) {
  console.error('用法：node build-single.js <輸出.html>');
  process.exit(1);
}

const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const html = read('index.html');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '避震 G 值計';

const inlined = body.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  const js = read(src);
  if (js.includes('</script')) throw new Error(`${src} 內含 </script，無法內嵌`);
  return `<script>\n${js}</script>`;
});

const page = [
  `<title>${title}</title>`,
  '<meta name="claude:viewport-fit-sides" content="cover">',
  `<style>\n${read('style.css')}</style>`,
  inlined.trim(),
  '',
].join('\n');

fs.writeFileSync(out, page);
console.log(`已輸出 ${out}（${(page.length / 1024).toFixed(0)} KB）`);
