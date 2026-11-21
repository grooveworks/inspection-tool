// inspection-tool 改修検証スクリプト
// 使い方: node tools/verify.js <改修前.html> <改修後.html> [出力フォルダ]
//   1) 両方を PC幅(1280) / タブレット幅(820) で描画し、案件一覧・測定・寸法編集・成績書・NC の画面を撮影
//   2) 画面ごとにピクセル差分を取り、差分のある矩形を出力（差分なし = "identical"）
//   3) 改修後に対して JSON取込の全パターンとNCチェック欄の保存を試験
//   Firebase は遮断し、localStorage（ローカルモード）で動かす
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');
const [,, baseHtml, newHtml, outDir = 'verify_out'] = process.argv;
if (!baseHtml || !newHtml) { console.error('usage: node tools/verify.js <before.html> <after.html> [outdir]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const full = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sample_full.json'), 'utf8'));

// 画面比較用の固定案件（測定値入り）
const seed = { id:"t1", partName:full.partName, drawingNo:full.drawingNo, rounds:5, roundsSet:true,
  inspector:"yk", date:"2026-11-17", serial:"S1", createdAt:1, updatedAt:1,
  dims: full.dims.slice(0,3).map((d,i) => ({ id:i+1, method:"", toolNo:"", jobNo:"", inReport:true, ...d })),
  meas: { 1:["49.925","","","",""], 2:["45.61","45.615","","",""], 3:["","","","",""] },
  nc: full.nc };

async function open(browser, html, w, h, errs, tag) {
  const pg = await browser.newPage({ viewport:{ width:w, height:h } });
  pg.on('pageerror', e => errs.push(tag + ': ' + e.message));
  pg.on('dialog', d => d.accept());
  await pg.route(/gstatic\.com/, r => r.abort());
  return pg;
}

async function shots(browser, html, prefix, errs) {
  const got = [];
  for (const [w, h, dev] of [[1280,800,'pc'], [820,1180,'tab']]) {
    const pg = await open(browser, html, w, h, errs, prefix + '/' + dev);
    await pg.addInitScript(p => { localStorage.setItem('_projects', JSON.stringify([p])); Date.now = () => 1763337600000; }, seed);
    await pg.goto('file://' + path.resolve(html)); await pg.waitForTimeout(300);
    const snap = async v => { await pg.screenshot({ path:`${outDir}/${prefix}_${dev}_${v}.png`, fullPage: v === 'report' || v === 'nc' }); got.push(`${dev}_${v}`); };
    await snap('list');
    await pg.click('text=' + seed.partName); await pg.waitForTimeout(300); await snap('meas');
    await pg.click('button:has-text("寸法編集")'); await pg.waitForTimeout(200); await snap('edit');
    await pg.click('button:has-text("編集を閉じる")'); await pg.waitForTimeout(200);
    await pg.click('button:has-text("成績書")'); await pg.waitForTimeout(300); await snap('report');
    if (await pg.$('button:text-matches("^NC")')) { await pg.click('button:text-matches("^NC")'); await pg.waitForTimeout(300); await snap('nc'); }
    await pg.close();
  }
  return got;
}

function diff(a, b) {
  const { PNG } = (() => { try { return require('pngjs'); } catch(e) { return {}; } })();
  if (!PNG) return pyDiff(a, b);
  const A = PNG.sync.read(fs.readFileSync(a)), B = PNG.sync.read(fs.readFileSync(b));
  if (A.width !== B.width || A.height !== B.height) return `size ${A.width}x${A.height} -> ${B.width}x${B.height}`;
  let x0=1e9,y0=1e9,x1=-1,y1=-1;
  for (let y=0;y<A.height;y++) for (let x=0;x<A.width;x++) { const i=(y*A.width+x)*4;
    if (A.data[i]!==B.data[i]||A.data[i+1]!==B.data[i+1]||A.data[i+2]!==B.data[i+2]) { if(x<x0)x0=x; if(y<y0)y0=y; if(x>x1)x1=x; if(y>y1)y1=y; } }
  return x1 < 0 ? 'identical' : `diff (${x0},${y0})-(${x1},${y1})`;
}
function pyDiff(a, b) {
  const r = require('child_process').spawnSync('python3', ['-c',
    'import sys;from PIL import Image,ImageChops;A=Image.open(sys.argv[1]).convert("RGB");B=Image.open(sys.argv[2]).convert("RGB");' +
    'print("size %sx%s -> %sx%s"%(A.size+B.size) if A.size!=B.size else ("identical" if ImageChops.difference(A,B).getbbox() is None else "diff %s"%(ImageChops.difference(A,B).getbbox(),)))', a, b]);
  return String(r.stdout).trim() || String(r.stderr).trim();
}

async function importTests(browser, html, errs) {
  const pg = await open(browser, html, 1280, 900, errs, 'import');
  const dialogs = []; pg.removeAllListeners('dialog'); pg.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await pg.goto('file://' + path.resolve(html)); await pg.waitForTimeout(300);
  const list = () => pg.evaluate(() => JSON.parse(localStorage.getItem('_projects') || '[]').map(p => ({ dno:p.drawingNo, dims:(p.dims||[]).length, nc:p.nc ? (p.nc.features||[]).length + (p.nc.dists||[]).length : 0, m1:(p.meas && p.meas[1] || [])[0] || '' })));
  const msg = () => pg.evaluate(() => { const t = document.querySelector('textarea'); return t ? t.nextElementSibling.textContent : ''; });
  const toList = async () => { if (await pg.$('text=←')) { await pg.click('text=←'); await pg.waitForTimeout(300); } };
  const imp = async v => { await toList(); if (!await pg.$('textarea')) await pg.click('text=JSONから取込'); await pg.fill('textarea', typeof v === 'string' ? v : JSON.stringify(v)); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(600); };
  const R = [], ok = (name, cond, info) => R.push(`${cond ? 'OK ' : 'NG '} ${name}${info ? '  ' + info : ''}`);
  const nTot = full.nc.features.length + full.nc.dists.length;

  await imp(full); let L = await list();
  ok('1 新規（dims+nc）→ 案件1件作成', L.length === 1 && L[0].dims === full.dims.length && L[0].nc === nTot, JSON.stringify(L));
  // 測定値を1つ入れる
  await pg.click('button:text-is("測定")').catch(()=>{}); await pg.waitForTimeout(200);
  const inp = (await pg.$$('td input:not([type=checkbox])'))[0]; if (inp) { await inp.fill('49.925'); await pg.waitForTimeout(800); }
  // NCチェック欄
  await pg.click('button:text-matches("^NC")'); await pg.waitForTimeout(300);
  const boxes = await pg.$$('input[type=checkbox]'); if (boxes[0]) { await boxes[0].check(); await pg.waitForTimeout(700); }
  const chk = await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects'))[0].nc.features[0].chk);
  ok('2 NCチェック欄が保存される', chk === true);
  await imp(full); L = await list();
  ok('3 同じ図番を再取込 → NCだけ置換・測定値保持・案件増えない', L.length === 1 && L[0].m1 === '49.925' && L[0].nc === nTot && dialogs.length === 1, JSON.stringify(L) + ' dialogs=' + dialogs.length);
  await imp({ drawingNo: full.drawingNo, nc: { dists: [{ nominal:16, upper:-0.05, lower:-0.3 }] } }); L = await list();
  ok('4 NCのみ（既存図番）→ 既存案件に入る', L.length === 1 && L[0].nc === 1 && L[0].m1 === '49.925', JSON.stringify(L));
  await imp({ nc: { dists: [{ nominal:16, upper:-0.05, lower:-0.3 }] } });
  ok('5 NCのみ（図番なし）→ エラー', /図番/.test(await msg()), await msg());
  await imp({ drawingNo:'NEW-1', nc: { dists: [{ nominal:16, upper:-0.05, lower:-0.3 }] } }); L = await list();
  ok('6 NCのみ（新しい図番）→ 新規案件', L.length === 2 && L.some(x => x.dno === 'NEW-1' && x.nc === 1));
  await imp({ partName:'X', drawingNo: full.drawingNo, dims: full.dims }); L = await list();
  ok('7 dimsのみ（既存図番）→ 新規案件（従来通り）', L.length === 3);
  await imp('{bad'); ok('8 不正JSON → エラー', /不正/.test(await msg()), await msg());
  await pg.fill('textarea', '{"partName":"a"}'); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(300);
  ok('9 dimsもncもない → エラー', /ありません/.test(await msg()), await msg());
  await pg.close();
  return R;
}

async function drawingTests(browser, html, errs) {
  // Google login / Picker / Drive are stubbed; pdf.js loads from cdnjs
  const pg = await open(browser, html, 1180, 820, errs, 'drawing');
  const st = path.join(__dirname, 'stubs'), fx = path.join(__dirname, 'fixtures');
  await pg.route(/accounts\.google\.com\/gsi\/client/, r => r.fulfill({ path:path.join(st,'gsi.js'), contentType:'application/javascript' }));
  await pg.route(/apis\.google\.com\/js\/api\.js/, r => r.fulfill({ path:path.join(st,'picker.js'), contentType:'application/javascript' }));
  let auth = '';
  await pg.route(/googleapis\.com\/drive\/v3\/files/, r => { auth = r.request().headers()['authorization'] || ''; r.fulfill({ path:path.join(fx,'test_drawing.pdf'), contentType:'application/pdf' }); });
  await pg.goto('file://' + path.resolve(html)); await pg.waitForTimeout(300);
  const j = { partName:'DRAWTEST', drawingNo:'DT-1',
    dims:[{ name:'φ10', nominal:10, upper:0.02, lower:0, type:'穴', locs:[{p:2,x:0.5,y:0.5,w:0.04,h:0.02}] }],
    nc:{ features:[{ name:'穴A', view:'A-A', dia:['φ10'], locs:[{p:1,x:0.1,y:0.1,w:0.05,h:0.03}] }], dists:[] } };
  await pg.click('text=JSONから取込'); await pg.fill('textarea', JSON.stringify(j)); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(600);
  const R = [], ok = (n, c, i) => R.push(`${c ? 'OK ' : 'NG '} ${n}${i ? '  ' + i : ''}`);
  const sp = () => pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')).find(p => p.drawingNo === 'DT-1'));
  let p = await sp();
  ok('D1 取込で位置(locs)が保存される', p.dims[0].locs.length === 1 && p.nc.features[0].locs.length === 1);
  await pg.click('button:text-is("図面")'); await pg.waitForTimeout(300);
  await pg.click('button:text-is("図面を選ぶ")'); await pg.waitForTimeout(3000);
  p = await sp();
  ok('D2 図面を選ぶ → 案件に図面が紐づく', p.drawing && p.drawing.fileId === 'FILE123', JSON.stringify(p.drawing));
  const pv = await pg.evaluate(() => window.__pickerView || {});
  ok('D6 選択画面はフォルダなし・一覧表示・図番で検索済み', pv.folders === false && pv.mode === 'list' && pv.query === 'DT-1' && pv.mime === 'application/pdf', JSON.stringify(pv));
  ok('D3 Drive読込にログイントークンが付く', auth === 'Bearer TESTTOKEN', auth);
  await pg.click('text=φ10 >> nth=0'); await pg.waitForTimeout(1500);
  const lbl = await pg.textContent('text=/ページ/').catch(() => '');
  ok('D4 行タップ → 該当ページへ移動して枠が出る', /^2 \//.test(lbl) && (await pg.$$('.drw-hl')).length === 1, lbl);
  // existing drawing number: locs attach to existing dims without touching values
  const j2 = JSON.parse(JSON.stringify(j)); j2.dims[0].locs = [{p:1,x:0.3,y:0.3,w:0.02,h:0.02}];
  await pg.click('text=←'); await pg.waitForTimeout(300);
  await pg.click('text=JSONから取込'); await pg.fill('textarea', JSON.stringify(j2)); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(700);
  const all = await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')).filter(p => p.drawingNo === 'DT-1'));
  ok('D5 同じ図番の再取込 → 既存の寸法に位置だけ更新・案件増えない', all.length === 1 && all[0].dims[0].locs[0].x === 0.3 && all[0].dims[0].upper === 0.02 && all[0].drawing.fileId === 'FILE123');
  // drawing link inside the import JSON
  const impJ = async v => { if (await pg.$('text=←')) { await pg.click('text=←'); await pg.waitForTimeout(300); }
    await pg.click('text=JSONから取込'); await pg.fill('textarea', JSON.stringify(v)); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(700); };
  const j3 = { partName:'DRAWTEST2', drawingNo:'DT-2', dims:j.dims, drawing:{ fileId:'FILE_NEW', name:'DT-2.pdf' } };
  await impJ(j3);
  let q = await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')).filter(p => p.drawingNo === 'DT-2'));
  ok('D7 取込JSONの drawing → 新規案件に図面が紐づく', q.length === 1 && q[0].drawing && q[0].drawing.fileId === 'FILE_NEW', JSON.stringify(q.map(x => x.drawing)));
  const nBefore = await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')).length);
  await impJ({ drawingNo:'DT-1', dims:j.dims, drawing:{ fileId:'FILE_RELINK', name:'DT-1.pdf' } });
  q = await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')));
  const d1 = q.filter(p => p.drawingNo === 'DT-1');
  ok('D8 既存図番に dims+drawing（ncなし）→ 図面だけ紐づけ・案件増えない・NC保持', q.length === nBefore && d1.length === 1 && d1[0].drawing.fileId === 'FILE_RELINK' && d1[0].nc.features.length === 1 && d1[0].dims[0].upper === 0.02, JSON.stringify(d1.map(x => x.drawing)));
  await impJ({ drawingNo:'NOPE-9', drawing:{ fileId:'X' } });
  const m = await pg.evaluate(() => { const t = document.querySelector('textarea'); return t ? t.nextElementSibling.textContent : ''; });
  ok('D9 図面だけ（該当図番なし）→ エラー・案件増えない', /案件がありません/.test(m) && (await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')).length)) === nBefore, m);
  await pg.close();
  return R;
}

(async () => {
  const browser = await chromium.launch(); const errs = [];
  const a = await shots(browser, baseHtml, 'before', errs), b = await shots(browser, newHtml, 'after', errs);
  console.log('== 画面差分（改修前 → 改修後）');
  for (const k of b) console.log((a.includes(k) ? diff(`${outDir}/before_${k}.png`, `${outDir}/after_${k}.png`) : 'new screen').padEnd(32), k);
  console.log('== 取込試験（改修後）');
  for (const r of await importTests(browser, newHtml, errs)) console.log(r);
  console.log('== 図面タブ試験（改修後）');
  for (const r of await drawingTests(browser, newHtml, errs)) console.log(r);
  console.log('== ページエラー'); console.log(errs.length ? errs.join('\n') : 'none');
  await browser.close();
})();
