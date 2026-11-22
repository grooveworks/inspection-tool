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
    nc:{ features:[{ name:'穴A', view:'A-A', dia:['φ10'], locs:[{p:1,x:0.1,y:0.1,w:0.05,h:0.03}] }], dists:[{ nominal:5, upper:0.1, lower:0, view:'A-A', locs:[{p:1,x:0.6,y:0.6,w:0.03,h:0.02}] }] } };
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
  const tc = await pg.evaluate(() => window.__tokenCfg || {});
  ok('D10 Googleログインは info-manager@groove-works.jp を指定（アカウント選択を出さない）', tc.login_hint === 'info-manager@groove-works.jp' && tc.hd === 'groove-works.jp', JSON.stringify(tc));
  await pg.click('text=φ10 >> nth=0'); await pg.waitForTimeout(1500);
  const lbl = await pg.textContent('text=/ページ/').catch(() => '');
  ok('D4 行タップ → 該当ページへ移動して枠が出る', /^2 \//.test(lbl) && (await pg.$$('.drw-hl')).length === 1, lbl);
  // same page → the drawing is not redrawn, only the box moves; the list is not rebuilt
  const rowSel = t => 'div[style*="cursor: pointer"]:has(span:text-is("' + t + '"))';
  await pg.click(rowSel('穴A')); await pg.waitForTimeout(1500);
  await pg.evaluate(() => { document.querySelector('canvas').__mark = 1; document.querySelector('div[style*="cursor: pointer"]').__mark = 1; });
  const box = () => pg.evaluate(() => { const e = document.querySelector('.drw-main'); return e ? Math.round(parseFloat(e.style.left)) : null; });
  const b1 = await box();
  const t0 = Date.now(); await pg.click(rowSel('5')); await pg.waitForFunction(b => { const e = document.querySelector('.drw-main'); return e && Math.round(parseFloat(e.style.left)) !== b; }, b1, { timeout:5000 }).catch(() => {});
  const tSame = Date.now() - t0;
  const same = await pg.evaluate(() => ({ canvas: document.querySelector('canvas').__mark === 1, list: document.querySelector('div[style*="cursor: pointer"]').__mark === 1, boxes: document.querySelectorAll('.drw-hl').length, sel: [...document.querySelectorAll('div[style*="cursor: pointer"]')].filter(e => e.style.background).length }));
  ok('D11 同じページの行タップ → 図面は描き直さず枠だけ移動・一覧も作り直さない', same.canvas && same.list && same.boxes === 1 && same.sel === 1 && (await box()) !== b1, JSON.stringify(same) + ' ' + tSame + 'ms');
  const w0 = await pg.evaluate(() => document.querySelector('canvas').width);
  await pg.click('button:text-is("＋")'); await pg.waitForFunction(w => { const c = document.querySelector('canvas'); return c && c.width > w; }, w0, { timeout:10000 }).catch(() => {});
  const z = await pg.evaluate(() => ({ w: document.querySelector('canvas').width, boxes: document.querySelectorAll('.drw-hl').length, lbl: document.body.innerText.match(/\d+ \/ \d+ ページ/)[0] }));
  ok('D12 拡大＋ → その倍率で描き直し・枠とページ表示はそのまま', z.w > w0 && z.boxes === 1 && /^1 \//.test(z.lbl), w0 + '→' + JSON.stringify(z));
  await pg.click('button:text-is("測定")'); await pg.waitForTimeout(200);
  const freed = await pg.evaluate(() => DRW.cv === null);
  await pg.click('button:text-is("図面")'); await pg.waitForSelector('.drw-hl', { timeout:10000 }).catch(() => {});
  ok('D13 他のタブへ移ると図面のメモリを解放・戻ると再表示', freed && (await pg.$$('.drw-hl')).length === 1 && (await pg.$$('canvas')).length === 1, 'freed=' + freed);
  // two-finger pinch (touch events via CDP)
  const cdp = await pg.context().newCDPSession(pg);
  const pinch = async (from, to) => {
    const r = await pg.evaluate(() => { const v = document.querySelector('.drw-hl').parentElement.parentElement.getBoundingClientRect(); return { x:v.left + v.width / 2, y:v.top + v.height / 2 }; });
    const pts = d => [{ x:r.x - d, y:r.y, id:1 }, { x:r.x + d, y:r.y, id:2 }];
    await cdp.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:pts(from) });
    for (let k = 1; k <= 6; k++) await cdp.send('Input.dispatchTouchEvent', { type:'touchMove', touchPoints:pts(from + (to - from) * k / 6) });
    await cdp.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] });
    return r;
  };
  const st0 = await pg.evaluate(() => { const v = document.querySelector('.drw-hl').parentElement.parentElement, p = v.firstChild, r = v.getBoundingClientRect();
    return { s:DRW.scale, w:DRW.cv.w, fx:(v.scrollLeft + r.width / 2 - p.offsetLeft) / DRW.cv.w, fy:(v.scrollTop + r.height / 2 - p.offsetTop) / DRW.cv.h }; });
  await pinch(50, 100); await pg.waitForFunction(s0 => DRW.cv && Math.abs(DRW.cv.scale - s0 * 2) < s0 * 0.05, st0.s, { timeout:10000 }).catch(() => {});
  await pg.waitForTimeout(300);
  const st1 = await pg.evaluate(() => { const v = document.querySelector('.drw-hl').parentElement.parentElement, p = v.firstChild, r = v.getBoundingClientRect();
    return { s:DRW.scale, w:DRW.cv.w, fx:(v.scrollLeft + r.width / 2 - p.offsetLeft) / DRW.cv.w, fy:(v.scrollTop + r.height / 2 - p.offsetTop) / DRW.cv.h, tf:p.style.transform, boxes:document.querySelectorAll('.drw-hl').length }; });
  ok('D14 2本指で広げる → 約2倍で描き直し・指の間の場所がずれない・赤枠そのまま', Math.abs(st1.s / st0.s - 2) < 0.1 && Math.abs(st1.w / st0.w - 2) < 0.1 && Math.abs(st1.fx - st0.fx) < 0.03 && Math.abs(st1.fy - st0.fy) < 0.03 && st1.tf === '' && st1.boxes === 1, JSON.stringify({ s0:+st0.s.toFixed(3), s1:+st1.s.toFixed(3), fx:[+st0.fx.toFixed(3), +st1.fx.toFixed(3)], fy:[+st0.fy.toFixed(3), +st1.fy.toFixed(3)] }));
  await pinch(100, 50); await pg.waitForFunction(s0 => DRW.cv && Math.abs(DRW.cv.scale - s0) < s0 * 0.05, st0.s, { timeout:10000 }).catch(() => {});
  const st2 = await pg.evaluate(() => DRW.scale);
  ok('D15 2本指で縮める → 元の倍率に戻る', Math.abs(st2 / st0.s - 1) < 0.06, st2.toFixed(3) + ' vs ' + st0.s.toFixed(3));
  for (let k = 0; k < 4; k++){ await pg.click('button:text-is("＋")'); await pg.waitForTimeout(700); }
  await pg.waitForFunction(() => document.querySelectorAll('canvas').length === 2, null, { timeout:15000 }).catch(() => {});
  const dz = await pg.evaluate(() => { const cs = [...document.querySelectorAll('canvas')], v = cs[0].parentElement.parentElement;
    return { n:cs.length, scale:+DRW.scale.toFixed(2), baseMP:+(cs[0].width * cs[0].height / 1e6).toFixed(1), detail: cs[1] ? [cs[1].width, cs[1].height] : null, view:[v.clientWidth, v.clientHeight], dpr:DRW.cv.dpr.toFixed(2), want:DRW.cv.want,
      boxAbove: (() => { const b = document.querySelector('.drw-hl'); return !!b && cs[1] && !!(cs[1].compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); })() }; });
  ok('D16 大きく拡大（全体画像が上限で粗くなる倍率）→ 見えている範囲だけ高精細で描き直す・赤枠はその上', dz.n === 2 && dz.baseMP <= 16.1 && dz.detail && dz.detail[0] >= dz.view[0] * dz.want - 2 && dz.boxAbove, JSON.stringify(dz));
  // existing drawing number: locs attach to existing dims without touching values
  const j2 = JSON.parse(JSON.stringify(j)); j2.dims[0].locs = [{p:1,x:0.3,y:0.3,w:0.02,h:0.02}];
  await pg.click('text=←'); await pg.waitForTimeout(300);
  await pg.click('text=JSONから取込'); await pg.fill('textarea', JSON.stringify(j2)); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(700);
  const all = await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')).filter(p => p.drawingNo === 'DT-1'));
  ok('D5 同じ図番の再取込 → 既存の寸法に位置だけ更新・案件増えない', all.length === 1 && all[0].dims[0].locs[0].x === 0.3 && all[0].dims[0].upper === 0.02 && all[0].drawing.fileId === 'FILE123');
  // drawing link inside the import JSON
  const impJ = async v => { if (await pg.$('text=←')) { await pg.click('text=←'); await pg.waitForTimeout(300); }
    if (!(await pg.$('textarea'))) await pg.click('text=JSONから取込'); await pg.fill('textarea', JSON.stringify(v)); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(700); };
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
  // revision diff (rev): attaches to the existing project only, marks rows by key, lists removed items
  const before = await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')).find(p => p.drawingNo === 'DT-1'));
  const rev = { from:'DT-1-00', items:[
      { g:'dims', nominal:10, upper:0.02, lower:0, k:'nom', old:'φ11' },
      { g:'features', name:'穴A', view:'A-A', k:'mod', t:'深さ変更' },
      { g:'dists', nominal:5, upper:0.1, lower:0, view:'A-A', k:'tol', old:'5 0/−0.1', est:true } ],
    gone:[ { g:'径', t:'φ9 削除' }, { g:'距離', t:'3 削除' } ], other:[ '材質変更' ] };
  await impJ({ drawingNo:'DT-1', rev });
  const after = await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')));
  const a1 = after.find(p => p.drawingNo === 'DT-1');
  const strip = p => JSON.stringify({ dims:p.dims, meas:p.meas, nc:p.nc, drawing:p.drawing });
  ok('R1 改訂データだけ取込 → 既存案件に保存・寸法/測定値/NC/図面はそのまま・案件増えない', after.length === nBefore && a1.rev && a1.rev.items.length === 3 && strip(a1) === strip(before), (a1.rev ? a1.rev.items.length : 'no rev') + ' / ' + after.length);
  let tx = await pg.evaluate(() => document.body.innerText);
  ok('R2 測定タブ：変わった行に「改訂：旧 φ11」・下に削除分（径）とその他の変更', /改訂：旧 φ11/.test(tx) && /旧版（DT-1-00）から削除/.test(tx) && /φ9 削除/.test(tx) && /材質変更/.test(tx) && !/3 削除/.test(tx), tx.slice(0, 0));
  await pg.click('button:text-matches("^NC")'); await pg.waitForTimeout(300);
  tx = await pg.evaluate(() => document.body.innerText);
  ok('R3 NCタブ：形状・距離の行に印、下に削除分（距離）', /改訂：深さ変更/.test(tx) && /改訂：旧 5 0\/−0\.1（公差のみ）（推定）/.test(tx) && /3 削除/.test(tx) && !/φ9 削除/.test(tx));
  await pg.click('button:text-is("図面")'); await pg.waitForTimeout(300);
  tx = await pg.evaluate(() => document.body.innerText);
  ok('R4 図面タブ：行に改訂の印', /改訂：旧 φ11/.test(tx) && /改訂：深さ変更/.test(tx));
  await impJ({ drawingNo:'DT-1', nc:j.nc });   // NC replaced → marks stay (matched by key)
  await pg.click('button:text-matches("^NC")'); await pg.waitForTimeout(300);
  tx = await pg.evaluate(() => document.body.innerText);
  ok('R5 NCを取込み直しても改訂の印は残る', /改訂：深さ変更/.test(tx) && /改訂：旧 5/.test(tx));
  await impJ({ drawingNo:'NOPE-9', rev });
  const m2 = await pg.evaluate(() => { const t = document.querySelector('textarea'); return t ? t.nextElementSibling.textContent : ''; });
  ok('R6 改訂データだけ（該当図番なし）→ エラー・案件増えない', /案件がありません/.test(m2) && (await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')).length)) === nBefore, m2);
  await pg.close();
  return R;
}

// cloud mode: Firebase SDK stubbed (tools/stubs/firebase-*.js), Firestore REST answered from the same in-memory data
const toFs = v => v === null ? { nullValue:null } : Array.isArray(v) ? { arrayValue:{ values:v.map(toFs) } }
  : typeof v === 'object' ? { mapValue:{ fields:Object.fromEntries(Object.entries(v).map(([k,x]) => [k, toFs(x)])) } }
  : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue:String(v) } : { doubleValue:v })
  : typeof v === 'boolean' ? { booleanValue:v } : { stringValue:String(v) };
async function cloudListTests(browser, html, errs) {
  // served over http://127.0.0.1 (a normal origin) — with file:// the localStorage written by one page was sometimes not yet visible after the next navigation
  const http = require('http');
  const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store' }); r.end(fs.readFileSync(path.resolve(html))); });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  const URL0 = 'http://127.0.0.1:' + srv.address().port + '/index.html';
  const st = path.join(__dirname, 'stubs');
  const cloud = [
    { ...seed, id:'c1', partName:'クラウド案件A', updatedAt:2000 },
    { ...seed, id:'c2', partName:'クラウド案件B', updatedAt:3000, drawing:{ fileId:'F', name:'b.pdf' } },
    { id:'c0', partName:'更新日時なし', drawingNo:'X', dims:[], meas:{} }          // the SDK query leaves this out
  ];
  const ctx = await browser.newContext({ viewport:{ width:1280, height:900 } });
  const pg = await ctx.newPage(); pg.on('pageerror', e => errs.push('cloud: ' + e.message)); pg.on('dialog', d => d.accept());
  let rest = { docs: cloud, delay: 0, fail: false }, restCalls = 0;
  await pg.route(/firebase-app-compat\.js/, r => r.fulfill({ path:path.join(st,'firebase-app.js'), contentType:'application/javascript' }));
  await pg.route(/firebase-firestore-compat\.js/, r => r.fulfill({ path:path.join(st,'firebase-firestore.js'), contentType:'application/javascript' }));
  await pg.route(/firebase-auth-compat\.js/, r => r.fulfill({ path:path.join(st,'firebase-auth.js'), contentType:'application/javascript' }));
  await pg.route(/accounts\.google\.com\/gsi\/client/, r => r.fulfill({ path:path.join(st,'gsi.js'), contentType:'application/javascript' }));
  await pg.route(/firestore\.googleapis\.com\/v1\//, async r => { restCalls++;
    if (rest.delay) await new Promise(ok => setTimeout(ok, rest.delay));
    if (rest.fail) return r.fulfill({ status:500, body:'{}' });
    r.fulfill({ status:200, contentType:'application/json', headers:{ 'access-control-allow-origin':'*' },
      body: JSON.stringify({ documents: rest.docs.map(d => ({ name:'projects/databases/(default)/documents/projects/' + d.id, ...toFs(d).mapValue })) }) }); });
  await pg.addInitScript(c => { window.__fsSeed = c; if (!localStorage.getItem('__loginTest')) localStorage.setItem('__stubAuth', JSON.stringify({ email:'info-manager@groove-works.jp' })); }, cloud);
  const R = [], ok = (n, c, i) => R.push(`${c ? 'OK ' : 'NG '} ${n}${i ? '  ' + i : ''}`);
  const cards = () => pg.$$eval('div[style*="cursor: pointer"] div[style*="font-size: 17px"]', e => e.map(x => x.textContent));
  const load = async () => { const t = Date.now(); await pg.goto(URL0); await pg.waitForSelector('text=クラウド案件', { timeout:15000 }); return Date.now() - t; };

  await load(); await pg.waitForTimeout(300);
  let c = await cards(), calls = await pg.evaluate(() => window.__fsStore.calls);
  ok('C1 初回（キャッシュなし）→ 1回の問い合わせ(REST)で一覧表示・SDKの一覧読込は使わない', c.join() === 'クラウド案件B,クラウド案件A' && restCalls === 1 && !calls.includes('sdk-list'), c.join() + ' rest=' + restCalls + ' ' + calls);
  const eq = await pg.evaluate(async () => { const n = v => Array.isArray(v) ? v.map(n) : (v && typeof v === 'object') ? Object.keys(v).sort().reduce((o,k)=>(o[k]=n(v[k]),o),{}) : v;
    const a = await fsRestList(); const s = await db.collection('projects').orderBy('updatedAt','desc').get(); const b = s.docs.map(d => ({ id:d.id, ...d.data() }));
    return JSON.stringify(n(a)) === JSON.stringify(n(b)); });
  ok('C2 REST の読込結果が SDK と完全一致（数値・入れ子・更新日時なしの除外）', eq);
  rest.delay = 3000; rest.docs = cloud.concat([{ ...seed, id:'c3', partName:'クラウド案件C(他端末で追加)', updatedAt:4000 }]);
  const tShow = await load(); c = await cards();
  ok('C3 2回目の起動 → 前回の一覧がすぐ出る（REST 3秒遅延でも）', tShow < 1500 && c.join() === 'クラウド案件B,クラウド案件A', tShow + 'ms ' + c.join());
  await pg.waitForSelector('text=クラウド案件C(他端末で追加)', { timeout:8000 }).catch(() => {}); c = await cards();
  ok('C4 最新が届いたら一覧が差し替わる', c[0] === 'クラウド案件C(他端末で追加)' && c.length === 3, c.join());
  rest.delay = 0; rest.fail = true; await pg.evaluate(() => localStorage.removeItem('_listCache')); await pg.waitForTimeout(400);   // let the write reach the next page
  await load(); await pg.waitForTimeout(300); c = await cards(); calls = await pg.evaluate(() => window.__fsStore.calls);
  ok('C5 REST が失敗 → SDK で一覧表示（従来の読み方）', calls.includes('sdk-list') && c.length === 2, c.join() + ' ' + calls);
  rest.fail = false;
  await pg.evaluate(() => localStorage.setItem('_projects', JSON.stringify([{ id:'L1', partName:'端末内の案件', dims:[], meas:{} }]))); await pg.waitForTimeout(400);
  await load(); await pg.waitForTimeout(300);
  const lsBefore = await pg.evaluate(() => localStorage.getItem('_projects'));
  rest.delay = 3000; rest.docs = rest.docs.filter(d => d.id !== 'c1');   // the refresh after delete arrives late
  await pg.click('div[style*="cursor: pointer"]:has-text("クラウド案件A") >> button:text-is("削除")'); await pg.waitForTimeout(500);
  const lc = await pg.evaluate(() => JSON.parse(localStorage.getItem('_listCache')).map(p => p.id)); calls = await pg.evaluate(() => window.__fsStore.calls);
  c = await cards();
  ok('C6 削除 → クラウドから削除・一覧キャッシュからも消え、すぐ一覧から消える', calls.includes('delete:c1') && !lc.includes('c1') && !c.includes('クラウド案件A'), lc + ' / ' + c.join() + ' / ' + calls);
  await pg.waitForTimeout(3500); rest.delay = 0;
  const lsAfter = await pg.evaluate(() => localStorage.getItem('_projects'));
  ok('C7 端末内データ(_projects)は一覧キャッシュで上書きされない', lsBefore === lsAfter && JSON.parse(lsAfter)[0].id === 'L1', String(lsAfter).slice(0, 60));
  // login (A1): once per device
  await pg.evaluate(() => { localStorage.setItem('__loginTest', '1'); localStorage.removeItem('__stubAuth'); }); await pg.waitForTimeout(400);
  await pg.goto(URL0); await pg.waitForTimeout(500);
  let tx = await pg.evaluate(() => document.body.innerText);
  ok('L1 未ログインの端末 → ログイン画面だけ出る（一覧は出ない）', /ログインが必要です/.test(tx) && !/クラウド案件/.test(tx));
  await pg.evaluate(() => { window.__stubLoginEmail = 'someone@gmail.com'; });
  await pg.click('button:text-is("Googleでログイン")'); await pg.waitForTimeout(500);
  tx = await pg.evaluate(() => document.body.innerText);
  const stillOut = await pg.evaluate(() => localStorage.getItem('__stubAuth'));
  ok('L2 別アカウントでログイン → 拒否・ログアウトしてログイン画面のまま', /info-manager@groove-works\.jp のみ/.test(tx) && !/クラウド案件/.test(tx) && stillOut === null, tx.split('\n').filter(l => /のみ/.test(l)).join());
  await pg.evaluate(() => { window.__stubLoginEmail = ''; });
  await pg.click('button:text-is("Googleでログイン")'); await pg.waitForSelector('text=クラウド案件', { timeout:5000 }).catch(() => {});
  const cred = await pg.evaluate(() => window.__credToken);
  tx = await pg.evaluate(() => document.body.innerText);
  ok('L3 info-manager でログイン → 一覧が出る（図面用と同じGoogleトークンを使用）', /クラウド案件/.test(tx) && cred === 'TESTTOKEN', 'cred=' + cred);
  await pg.goto(URL0); await pg.waitForTimeout(500);
  tx = await pg.evaluate(() => document.body.innerText);
  ok('L4 2回目以降の起動 → ログイン画面は出ない', !/ログインが必要です/.test(tx) && /クラウド案件/.test(tx));
  await ctx.close(); srv.close();
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
  console.log('== 一覧の読込試験（同期モード・Firebaseは tools/stubs で差し替え）');
  for (const r of await cloudListTests(browser, newHtml, errs)) console.log(r);
  console.log('== ページエラー'); console.log(errs.length ? errs.join('\n') : 'none');
  await browser.close();
})();
