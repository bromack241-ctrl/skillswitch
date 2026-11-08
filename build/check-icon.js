// 从 exe 里把图标读回来，确认真的嵌进去了
const fs = require('fs');
const ResEdit = require('resedit');

const exePath = process.argv[2];
const outPng = process.argv[3];

const nt = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(nt);
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
console.log('icon groups:', groups.length);
if (!groups.length) process.exit(2);

const icons = groups[0].icons;
console.log('sizes in group:', icons.map(i => i.width + 'x' + i.height).join(', '));

let best = null;
for (const ic of icons) {
  if (!best || (ic.width * ic.height) > (best.width * best.height)) best = ic;
}
console.log('picked:', best.width + 'x' + best.height, 'bytes=', best.data.length);
const buf = Buffer.from(best.data);
const isPng = buf[0] === 0x89 && buf[1] === 0x50;
console.log('format:', isPng ? 'PNG' : 'BMP(ICO payload)');
if (isPng) {
  fs.writeFileSync(outPng, buf);
  console.log('wrote', outPng);
}
