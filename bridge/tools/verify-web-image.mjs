import fs from 'node:fs';
import path from 'node:path';

const url = 'http://127.0.0.1:18901/v1/chat/completions';
const prompt = '用python matplotlib画一下摆线（旋轮线），生成图表展示。';

console.log('Sending streaming request to bridge on gemini-web-pro...');
const t0 = Date.now();

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer sk-local-gemini-web',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'gemini-web-pro',
    messages: [{ role: 'user', content: prompt }],
    stream: true,
  }),
  signal: AbortSignal.timeout(300000),
});

console.log(`Status: ${res.status} in ${Date.now() - t0}ms`);
let content = '';
const text = await res.text();
for (const line of text.split('\n')) {
  if (line.startsWith('data: ') && !line.includes('[DONE]')) {
    try {
      const c = JSON.parse(line.slice(6));
      const delta = c.choices?.[0]?.delta?.content;
      if (delta) content += delta;
    } catch {}
  }
}
console.log('Content length:', content.length);

const hasDataUrl = content.includes('data:image/');
const hasDeadPlaceholder = /googleusercontent\.com\/(generated_image|image_generation_content)/.test(content);
const hasRelativePng = /!\[[^\]]*\]\([a-zA-Z0-9_\-]+\.png\)/.test(content);

console.log('Has inline data:image URL:', hasDataUrl);
console.log('Has dead googleusercontent placeholder:', hasDeadPlaceholder);
console.log('Has dead relative .png markdown:', hasRelativePng);

if (hasDataUrl) {
  const m = content.match(/data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+/);
  if (m) {
    console.log('SUCCESS! Found data URL of length:', m[0].length);
    console.log('Prefix:', m[0].slice(0, 60));
  }
}

// Print snippet of image area in markdown
const imgIdx = content.indexOf('![') !== -1 ? content.indexOf('![') : content.indexOf('data:image/');
if (imgIdx !== -1) {
  console.log('\n--- Markdown Snippet Around Image ---');
  console.log(content.slice(Math.max(0, imgIdx - 100), imgIdx + 200));
} else {
  console.log('\n--- Content Tail ---');
  console.log(content.slice(-500));
}

process.exitCode = hasDataUrl ? 0 : 1;
