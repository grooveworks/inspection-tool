// inspection-tool 改修検証スクリプト
// 使い方: node tools/verify.js <改修前.html> <改修後.html> [出力フォルダ]
//   1) 両方を PC幅(1280) / タブレット幅(820) で描画し、案件一覧・測定・寸法編集・成績書・NC の画面を撮影
//   2) 画面ごとにピクセル差分を取り、差分のある矩形を出力（差分なし = "identical"）
//   3) 改修後に対して JSON取込・図面（CAMタブ／測定タブ）・縦横の持ち替え・成績書・一覧読込を試験
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
    if (await pg.$('button:text-matches("^(NC|CAM)")')) { await pg.click('button:text-matches("^(NC|CAM)")'); await pg.waitForTimeout(300); await snap('nc'); }
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

// v2.16.0: the CAM tab opens on "モデル修正"; the older tests look at the feature cards ("形状ごと")
async function feat(pg){ const s = await pg.$('.cam-seg:has-text("形状ごと")'); if (s){ await s.click(); await pg.waitForTimeout(300); } }
async function camTab(pg){ await pg.click('button:text-matches("^CAM")'); await pg.waitForTimeout(150); await feat(pg); }

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
  ok('M0 図面のない案件は測定タブに「図面」ボタンを出さない', !(await pg.$('.meas-drw-btn')));
  // NCチェック欄
  await camTab(pg); await pg.waitForTimeout(300);
  const boxes = await pg.$$('.cam-chk'); if (boxes[0]) { await boxes[0].check(); await pg.waitForTimeout(700); }
  const chk = await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects'))[0].nc.features[0].chks);
  ok('2 CAMのチェック欄が値ごとに保存される（1つ目の値 φ50 だけ済み）', JSON.stringify(chk) === JSON.stringify(['dia|φ50 -0.067/-0.083']), JSON.stringify(chk));
  const camTx = await pg.evaluate(() => document.body.innerText);
  const tabs = await pg.$$eval('button', b => b.map(x => x.textContent.trim()).filter(t => /^(測定|図面)$|^(CAM|成績書|NC)( |\(|$)/.test(t)));
  ok('T1 タブは「測定｜CAM｜成績書」の3つ（図面タブ・NCタブなし）', tabs.length === 3 && /^測定/.test(tabs[0]) && /^CAM/.test(tabs[1]) && /^成績書/.test(tabs[2]), JSON.stringify(tabs));
  ok('N1 表示名がCAM：タブ「CAM」・「CAMデータ取込」ボタン・画面にNCの表示が残っていない', !!(await pg.$('button:text-matches("^CAM")')) && !!(await pg.$('button:text-is("CAMデータ取込")')) && !/(^|[^A-Za-z])NC([^A-Za-z]|$)/m.test(camTx), (camTx.match(/.{0,10}NC.{0,10}/) || [''])[0]);
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
  await camTab(pg); await pg.waitForTimeout(300);
  await pg.click('button:text-is("図面を選ぶ")'); await pg.waitForTimeout(3000);
  p = await sp();
  ok('D2 図面を選ぶ → 案件に図面が紐づく', p.drawing && p.drawing.fileId === 'FILE123', JSON.stringify(p.drawing));
  const pv = await pg.evaluate(() => window.__pickerView || {});
  ok('D6 選択画面はフォルダなし・一覧表示・図番で検索済み', pv.folders === false && pv.mode === 'list' && pv.query === 'DT-1' && pv.mime === 'application/pdf', JSON.stringify(pv));
  ok('D3 Drive読込にログイントークンが付く', auth === 'Bearer TESTTOKEN', auth);
  const tc = await pg.evaluate(() => window.__tokenCfg || {});
  ok('D10 Googleログインは info-manager@groove-works.jp を指定（アカウント選択を出さない）', tc.login_hint === 'info-manager@groove-works.jp' && tc.hd === 'groove-works.jp', JSON.stringify(tc));
  const rowSel = t => '.cam-row:has(span:text-is("' + t + '"))';
  ok('D17 CAMタブは図面と同じ画面：左に形状ごとの一覧（カード）・右に図面', (await pg.$$('.cam-row')).length === 2 && (await pg.$$('canvas')).length === 1 && await pg.evaluate(() => { const a = document.querySelector('.cam-row').getBoundingClientRect(), c = document.querySelector('canvas').parentElement.parentElement.getBoundingClientRect(); return a.right <= c.left + 1; }));
  await pg.click(rowSel('穴A')); await pg.waitForTimeout(1500);
  const lbl = await pg.textContent('text=/ページ/').catch(() => '');
  ok('D4 カードをタップ → 該当ページへ移動して枠が出る', /^1 \//.test(lbl) && (await pg.$$('.drw-hl')).length === 1, lbl);
  const drTx = await pg.evaluate(() => document.body.innerText);
  ok('N2 CAMタブ（図面つき）にNCの表示が残っていない', /CAMデータ取込/.test(drTx) && !/(^|[^A-Za-z])NC([^A-Za-z]|$)/m.test(drTx), (drTx.match(/.{0,10}NC.{0,10}/) || [''])[0]);
  ok('G5 普通公差のない案件：図面タブに規格の帯・「普通」の印・点線枠を出さない', !(await pg.$('.gen-std')) && !(await pg.$('.gen-badge')) && (await pg.$$('.drw-gen')).length === 0 && !/普通/.test(drTx));
  // same page → the drawing is not redrawn, only the box moves; the list is not rebuilt
  await pg.evaluate(() => { document.querySelector('canvas').__probe = 1; document.querySelector('.cam-row').__probe = 1; });
  const box = () => pg.evaluate(() => { const e = document.querySelector('.drw-main'); return e ? Math.round(parseFloat(e.style.left)) : null; });
  const b1 = await box();
  const t0 = Date.now(); await pg.click('.cam-row >> nth=1'); await pg.waitForFunction(b => { const e = document.querySelector('.drw-main'); return e && Math.round(parseFloat(e.style.left)) !== b; }, b1, { timeout:5000 }).catch(() => {});
  const tSame = Date.now() - t0;
  const same = await pg.evaluate(() => ({ canvas: document.querySelector('canvas').__probe === 1, list: document.querySelector('.cam-row').__probe === 1, boxes: document.querySelectorAll('.drw-hl').length, sel: [...document.querySelectorAll('.cam-row')].filter(e => e.style.background).length }));
  ok('D11 同じページの行タップ → 図面は描き直さず枠だけ移動・一覧も作り直さない', same.canvas && same.list && same.boxes === 1 && same.sel === 1 && (await box()) !== b1, JSON.stringify(same) + ' ' + tSame + 'ms');
  const w0 = await pg.evaluate(() => document.querySelector('canvas').width);
  await pg.click('button:text-is("＋")'); await pg.waitForFunction(w => { const c = document.querySelector('canvas'); return c && c.width > w; }, w0, { timeout:10000 }).catch(() => {});
  const z = await pg.evaluate(() => ({ w: document.querySelector('canvas').width, boxes: document.querySelectorAll('.drw-hl').length, lbl: document.body.innerText.match(/\d+ \/ \d+ ページ/)[0] }));
  ok('D12 拡大＋ → その倍率で描き直し・枠とページ表示はそのまま', z.w > w0 && z.boxes === 1 && /^1 \//.test(z.lbl), w0 + '→' + JSON.stringify(z));
  await pg.click('button:text-is("測定")'); await pg.waitForTimeout(200);
  const freed = await pg.evaluate(() => DRW.cv === null);
  await camTab(pg); await pg.waitForSelector('.drw-hl', { timeout:10000 }).catch(() => {});
  ok('D13 他のタブへ移ると図面のメモリを解放・戻ると再表示（選んでいたカードと枠もそのまま）', freed && (await pg.$$('.drw-hl')).length === 1 && (await pg.$$('canvas')).length === 1, 'freed=' + freed);
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
  // measurement tab: the drawing can be opened beside the table (dims rows → their place on the drawing)
  await pg.click('button:text-is("測定")'); await pg.waitForTimeout(300);
  const mm0 = await pg.evaluate(() => ({ cv: DRW.cv === null, canvas: document.querySelectorAll('canvas').length, btn: !!document.querySelector('.meas-drw-btn') }));
  await pg.click('.meas-drw-btn'); await pg.waitForSelector('canvas', { timeout:10000 }).catch(() => {});
  await pg.click('tr[data-row] td:nth-child(3)'); await pg.waitForTimeout(1800);
  const mm1 = await pg.evaluate(() => { const tr = document.querySelector('tr[data-row]'), cv = document.querySelector('canvas'), t = tr.closest('table').parentElement.getBoundingClientRect(), v = cv.parentElement.parentElement.getBoundingClientRect();
    return { lbl:(document.body.innerText.match(/\d+ \/ \d+ ページ/) || [''])[0], boxes:document.querySelectorAll('.drw-hl').length, outline:tr.style.outline, side:t.right <= v.left + 1, btn:document.querySelector('.meas-drw-btn').textContent }; });
  ok('M1 測定タブ「図面」→ 表の横に図面・寸法の行タップで該当ページ（2ページ目）に赤枠・行に青枠', mm0.btn && mm0.cv && mm0.canvas === 0 && /^2 \//.test(mm1.lbl) && mm1.boxes === 1 && /solid/.test(mm1.outline) && mm1.side && mm1.btn === '図面を閉じる', JSON.stringify([mm0, mm1]));
  const mi = await pg.$('tr[data-row] td input:not([type=checkbox])'); await mi.click(); await mi.fill('10.01'); await pg.waitForTimeout(900);
  const mm2 = await pg.evaluate(() => ({ v:(JSON.parse(localStorage.getItem('_projects')).find(p => p.drawingNo === 'DT-1').meas[1] || [])[0], boxes:document.querySelectorAll('.drw-hl').length, canvas:document.querySelectorAll('canvas').length, sel:DRW.sel }));
  ok('M2 図面を出したまま測定値を入力できる（値は保存・図面と赤枠はそのまま）', mm2.v === '10.01' && mm2.boxes === 1 && mm2.canvas >= 1 && mm2.sel === 0, JSON.stringify(mm2));
  await pg.click('.meas-drw-btn'); await pg.waitForTimeout(400);
  const mm3 = await pg.evaluate(() => ({ cv: DRW.cv === null, canvas: document.querySelectorAll('canvas').length, w: Math.round(document.querySelector('tr[data-row]').closest('table').parentElement.getBoundingClientRect().width), vw: innerWidth }));
  ok('M3 「図面を閉じる」→ 図面が消えてメモリ解放・表は元の幅', mm3.cv && mm3.canvas === 0 && mm3.w > mm3.vw * 0.9, JSON.stringify(mm3));
  // rotating the tablet (crossing 900px) lays the screen out again: side by side ⇄ list above / drawing below
  const lay = () => pg.evaluate(() => { const a = document.querySelector('.cam-row'), cv = document.querySelector('canvas'); if (!a || !cv) return null;
    const r = a.parentElement.getBoundingClientRect(), v = cv.parentElement.parentElement.getBoundingClientRect();
    return { side: r.right <= v.left + 1, stack: r.bottom <= v.top + 1, boxes: document.querySelectorAll('.drw-hl').length }; });
  await camTab(pg); await pg.waitForSelector('.drw-hl', { timeout:10000 }).catch(() => {}); await pg.waitForTimeout(500);
  const o0 = await lay();
  await pg.setViewportSize({ width:820, height:1180 }); await pg.waitForTimeout(800); await pg.waitForSelector('.drw-hl', { timeout:10000 }).catch(() => {});
  const o1 = await lay();
  ok('O1 タブレットを縦にする → CAMタブは一覧が上・図面が下に並び替わる（選んだカードの赤枠そのまま）', o0 && o0.side && o1 && o1.stack && o1.boxes === 1, JSON.stringify([o0, o1]));
  await pg.click('button:text-is("測定")'); await pg.waitForTimeout(300); await pg.click('.meas-drw-btn'); await pg.waitForSelector('canvas', { timeout:10000 }).catch(() => {});
  const o2 = await pg.evaluate(() => { const t = document.querySelector('tr[data-row]').closest('table').getBoundingClientRect(), v = document.querySelector('canvas').parentElement.parentElement.getBoundingClientRect(); return { stack: t.top < v.top && v.top >= t.top + 100 }; });
  await pg.click('.meas-drw-btn'); await pg.waitForTimeout(300); await camTab(pg); await pg.waitForTimeout(300);
  await pg.setViewportSize({ width:1180, height:820 }); await pg.waitForTimeout(800); await pg.waitForSelector('.drw-hl', { timeout:10000 }).catch(() => {});
  const o3 = await lay();
  ok('O2 縦では測定タブの図面も表の下・横に戻すと左右の並びに戻る', o2.stack && o3 && o3.side && o3.boxes === 1, JSON.stringify([o2, o3]));
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
  await camTab(pg); await pg.waitForTimeout(300);
  tx = await pg.evaluate(() => document.body.innerText);
  ok('R3 NCタブ：形状・距離の行に印、下に削除分（距離）', /改訂：深さ変更/.test(tx) && /改訂：旧 5 0\/−0\.1（公差のみ）（推定）/.test(tx) && /3 削除/.test(tx) && !/φ9 削除/.test(tx));
  await pg.click('button:text-is("測定")'); await pg.waitForTimeout(300); await pg.click('.meas-drw-btn'); await pg.waitForTimeout(500);
  tx = await pg.evaluate(() => document.body.innerText);
  ok('R4 測定タブで図面を出しても行の改訂の印・削除分はそのまま', /改訂：旧 φ11/.test(tx) && /φ9 削除/.test(tx) && /図面（Google Drive）/.test(tx));
  await pg.click('.meas-drw-btn'); await pg.waitForTimeout(300);
  await impJ({ drawingNo:'DT-1', nc:j.nc });   // NC replaced → marks stay (matched by key)
  await camTab(pg); await pg.waitForTimeout(300);
  tx = await pg.evaluate(() => document.body.innerText);
  ok('R5 NCを取込み直しても改訂の印は残る', /改訂：深さ変更/.test(tx) && /改訂：旧 5/.test(tx));
  await impJ({ drawingNo:'NOPE-9', rev });
  const m2 = await pg.evaluate(() => { const t = document.querySelector('textarea'); return t ? t.nextElementSibling.textContent : ''; });
  ok('R6 改訂データだけ（該当図番なし）→ エラー・案件増えない', /案件がありません/.test(m2) && (await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')).length)) === nBefore, m2);
  await pg.close();
  return R;
}

// report: numbered-balloon drawing sheet (v2.9.0). Google login / Drive stubbed; print checked with Chromium's PDF output
async function reportSheetTests(browser, html, errs) {
  const pg = await open(browser, html, 1180, 820, errs, 'sheet');
  const st = path.join(__dirname, 'stubs'), fx = path.join(__dirname, 'fixtures');
  await pg.route(/accounts\.google\.com\/gsi\/client/, r => r.fulfill({ path:path.join(st,'gsi.js'), contentType:'application/javascript' }));
  let drive = 0;
  await pg.route(/googleapis\.com\/drive\/v3\/files/, r => { drive++; r.fulfill({ path:path.join(fx,'test_drawing.pdf'), contentType:'application/pdf' }); });
  await pg.goto('file://' + path.resolve(html)); await pg.waitForTimeout(300);
  const L = (p, x, y) => [{ p, x, y, w:0.03, h:0.02 }];
  const dim = (n, locs) => ({ name:'φ' + n, nominal:n, upper:0.02, lower:0, type:'穴', locs });
  const j = { partName:'SHEETTEST', drawingNo:'RS-1', drawing:{ fileId:'FILE_RS', name:'RS-1.pdf' },
    dims:[ dim(10, L(1,0.5,0.5)), dim(11, L(1,0.505,0.5)), dim(12, L(1,0.5,0.51)), dim(13, L(1,0.51,0.505)), dim(14, L(2,0.2,0.3)), dim(15, []) ] };
  const imp = async v => { await pg.click('text=JSONから取込'); await pg.fill('textarea', JSON.stringify(v)); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(600); };
  await imp(j);
  const R = [], ok = (n, c, i) => R.push(`${c ? 'OK ' : 'NG '} ${n}${i ? '  ' + i : ''}`);
  const pdfPages = async () => { const b = await pg.pdf({ preferCSSPageSize:true });
    return require('child_process').spawnSync('python3', ['-c', 'import sys,io,pypdf;r=pypdf.PdfReader(io.BytesIO(sys.stdin.buffer.read()));print(" ".join("%dx%d"%(round(float(p.mediabox.width)),round(float(p.mediabox.height))) for p in r.pages))'], { input:b }).stdout.toString().trim(); };
  await pg.click('button:has-text("測定")').catch(() => {}); await pg.click('button:has-text("成績書")'); await pg.waitForTimeout(300);
  const s1 = await pg.evaluate(() => ({ btn: !!document.querySelector('button') && [...document.querySelectorAll('button')].some(b => b.textContent === '番号付き図面を表示'),
    card: [...document.querySelectorAll('.no-print')].some(e => /検査箇所図/.test(e.textContent)), sheets: document.querySelectorAll('.drw-sheet').length, flow: document.querySelectorAll('.print-flow').length }));
  const pp1 = await pdfPages();
  ok('S1 図面未読込・未ログイン → 「番号付き図面を表示」ボタン（印刷されない）・自動で読みに行かない・印刷は成績書1枚だけ', s1.btn && s1.card && s1.sheets === 0 && drive === 0 && pp1 === '595x842', JSON.stringify(s1) + ' drive=' + drive + ' pdf=' + pp1);
  await pg.click('button:text-is("番号付き図面を表示")');
  await pg.waitForFunction(() => { const i = [...document.querySelectorAll('.drw-sheet-img')]; return i.length && i.every(x => x.complete && x.naturalWidth > 0 && x.dataset.marks); }, null, { timeout:60000 }).catch(() => {});
  const s2 = await pg.evaluate(() => ({ marks: [...document.querySelectorAll('.drw-sheet-img')].map(i => JSON.parse(i.dataset.marks || '[]')), text: [...document.querySelectorAll('.drw-sheet')].map(e => e.innerText).join(' | ') }));
  const nums = s2.marks.map(m => m.map(x => x.n).join(','));
  ok('S2 読込後 → 位置のあるページごとに1枚・番号は成績書のNo.・位置のない項目は注記', nums.join('/') === '1,2,3,4/5' && /（1\/2）/.test(s2.text) && /（2\/2）/.test(s2.text) && /図面に位置のない項目: No\.6/.test(s2.text) && drive === 1, nums.join('/') + ' ' + s2.text.replace(/\s+/g, ' ').slice(0, 160));
  const m1 = s2.marks[0] || [], gap = [];
  for (let a = 0; a < m1.length; a++) for (let b = a + 1; b < m1.length; b++){ const A = m1[a], B = m1[b];
    gap.push(Math.hypot((A.x - B.x), (A.y - B.y) / A.ar) / A.r); }
  const inside = s2.marks.flat().every(m => m.x - m.r > 0 && m.x + m.r < 1 && m.y - m.r * m.ar > 0 && m.y + m.r * m.ar < 1);
  ok('S3 密集した寸法でも番号の丸が重ならない・用紙からはみ出さない', m1.length === 4 && Math.min(...gap) >= 2 && inside, 'min gap ' + Math.min(...gap).toFixed(2) + 'R inside=' + inside);
  const pp2 = await pdfPages();
  ok('S4 印刷 → 1枚目 成績書 A4縦・続けて図面 A3横（ページごと）', pp2 === '595x842 1191x842 1191x842', pp2);
  await pg.click('button:text-is("測定")'); await pg.waitForTimeout(200); await pg.click('button:has-text("成績書")');
  await pg.waitForFunction(() => document.querySelectorAll('.drw-sheet-img').length === 2, null, { timeout:20000 }).catch(() => {});
  ok('S5 タブを戻っても再ダウンロードせずに表示', (await pg.$$('.drw-sheet-img')).length === 2 && drive === 1, 'drive=' + drive);
  await pg.evaluate(() => { DRW.pdf = null; DRW.fileId = null; SHEET_AUTO = ''; });
  await pg.click('button:text-is("測定")'); await pg.waitForTimeout(200); await pg.click('button:has-text("成績書")');
  await pg.waitForFunction(() => document.querySelectorAll('.drw-sheet-img').length === 2, null, { timeout:30000 }).catch(() => {});
  ok('S6 Googleログイン済みなら押さなくても自動で表示', (await pg.$$('.drw-sheet-img')).length === 2 && drive === 2, 'drive=' + drive);
  await pg.click('text=←'); await pg.waitForTimeout(300);
  await imp({ partName:'SHEETTEST2', drawingNo:'RS-2', dims:j.dims });
  await pg.click('text=RS-2').catch(() => {}); await pg.waitForTimeout(300);
  await pg.click('button:has-text("成績書")'); await pg.waitForTimeout(300);
  const s7 = await pg.evaluate(() => ({ t: /検査箇所図|番号付き図面/.test(document.body.innerText) }));
  ok('S7 図面が紐づいていない案件 → 成績書は従来どおり（図面欄なし）', !s7.t && (await pdfPages()) === '595x842', JSON.stringify(s7));
  // long report: every row must be printed (v2.9.1; before, printing stopped at the screen height)
  await pg.click('text=←'); await pg.waitForTimeout(300);
  await imp({ partName:'LONGTEST', drawingNo:'RS-3', dims:Array.from({ length:45 }, (_, i) => ({ name:'φ' + (100 + i), nominal:100 + i, upper:0.02, lower:0, type:'穴' })) });
  await pg.click('text=RS-3').catch(() => {}); await pg.waitForTimeout(300);
  await pg.click('button:has-text("成績書")'); await pg.waitForTimeout(300);
  const lb = await pg.pdf({ preferCSSPageSize:true });
  const lt = require('child_process').spawnSync('python3', ['-c', 'import sys,io,pypdf;r=pypdf.PdfReader(io.BytesIO(sys.stdin.buffer.read()));print(len(r.pages));print("".join(p.extract_text() for p in r.pages))'], { input:lb }).stdout.toString();
  const lp = +lt.split('\n')[0], miss = Array.from({ length:45 }, (_, i) => 100 + i).filter(n => !lt.includes('φ' + n) && !lt.includes(String(n)));
  ok('S8 行の多い成績書（45行）→ 全行が複数ページに続けて印刷される・総合判定まで出る', lp >= 2 && !miss.length && /総合判定/.test(lt), 'pages=' + lp + ' missing=' + miss.join(','));
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

async function genTests(browser, html, errs) {
  // general-tolerance rows (dims[].gen = maker standard name) → "普通" badge on the measurement tab
  const pg = await open(browser, html, 820, 1180, errs, 'gen');
  await pg.goto('file://' + path.resolve(html)); await pg.waitForTimeout(300);
  const R = [], ok = (n, c, i) => R.push(`${c ? 'OK ' : 'NG '} ${n}${i ? '  ' + i : ''}`);
  const j = { partName:'GENTEST', drawingNo:'GT-1', dims:[
    { name:'φ47', tClass:'P7', nominal:47, upper:-0.017, lower:-0.042, type:'穴' },
    { name:'φ20', nominal:20, upper:0.3, lower:0, type:'穴', qty:2, gen:'YGK-2-001' },
    { name:'φ60', nominal:60, upper:0, lower:-0.3, type:'軸', gen:'YGK-2-001', inReport:false } ] };
  await pg.click('text=JSONから取込'); await pg.fill('textarea', JSON.stringify(j)); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(600);
  const p = await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')).find(x => x.drawingNo === 'GT-1'));
  ok('G1 取込で gen（規格名）が保存される・gen のない行には項目を作らない', p.dims[1].gen === 'YGK-2-001' && p.dims[2].gen === 'YGK-2-001' && !('gen' in p.dims[0]), JSON.stringify(p.dims.map(d => d.gen)));
  ok('G2 成績書の掲載は取込JSONの inReport のまま（gen では変えない）', p.dims[1].inReport === true && p.dims[2].inReport === false);
  if (!(await pg.$('.gen-badge'))) { await pg.click('text=GENTEST'); await pg.waitForTimeout(400); }
  const rows = await pg.evaluate(() => [...document.querySelectorAll('tr')].filter(r => r.querySelector('select')).map(r => ({ t:r.innerText.split('\n')[0] + ' ' + r.innerText.split('\n')[1], g:!!r.querySelector('.gen-badge') })));
  const badges = await pg.$$eval('.gen-badge', b => b.map(x => x.textContent + '|' + x.getAttribute('title')));
  ok('G3 測定タブ：gen のある行だけ「普通」の印（title に規格名）', badges.length === 2 && badges.every(b => b === '普通|普通公差（YGK-2-001）') && rows.filter(r => r.g).length === 2, JSON.stringify(badges) + ' ' + JSON.stringify(rows));
  // additional import (寸法編集 → 追加インポート) uses the same converter
  const p2 = await pg.evaluate(() => { const d = dimFromJSON({ nominal:8, upper:0.2, lower:0, type:'穴', gen:'HES D 0001-08 1級' }, 99); return d.gen; });
  ok('G4 追加インポートの変換でも gen を保持', p2 === 'HES D 0001-08 1級', p2);
  await pg.close();
  return R;
}

async function genDrawTests(browser, html, errs) {
  // drawing tab: project-level standard band, "普通" badges / values on rows, always-on dashed frames for locs with g:1
  const pg = await open(browser, html, 1180, 820, errs, 'gendraw');
  const st = path.join(__dirname, 'stubs'), fx = path.join(__dirname, 'fixtures');
  await pg.route(/accounts\.google\.com\/gsi\/client/, r => r.fulfill({ path:path.join(st,'gsi.js'), contentType:'application/javascript' }));
  await pg.route(/apis\.google\.com\/js\/api\.js/, r => r.fulfill({ path:path.join(st,'picker.js'), contentType:'application/javascript' }));
  await pg.route(/googleapis\.com\/drive\/v3\/files/, r => r.fulfill({ path:path.join(fx,'test_drawing.pdf'), contentType:'application/pdf' }));
  await pg.goto('file://' + path.resolve(html)); await pg.waitForTimeout(300);
  const R = [], ok = (n, c, i) => R.push(`${c ? 'OK ' : 'NG '} ${n}${i ? '  ' + i : ''}`);
  const S = 'HES D 0001-08 2級', b1 = {p:1,x:0.1,y:0.1,w:0.05,h:0.03}, g1 = {p:1,x:0.3,y:0.3,w:0.04,h:0.02,g:1}, g2 = {p:1,x:0.5,y:0.2,w:0.04,h:0.02,g:1}, g3 = {p:2,x:0.5,y:0.5,w:0.04,h:0.02,g:1};
  const j = { partName:'GENDRAW', drawingNo:'GD-1', gen:S,
    dims:[{ name:'φ36', nominal:36, upper:0, lower:-0.6, type:'軸', gen:S, locs:[g1] }, { name:'φ24', tClass:'R7', nominal:24, upper:-0.02, lower:-0.041, type:'穴', locs:[b1] }],
    nc:{ features:[{ name:'大端ボア', view:'F-F', dia:['φ24 R7 −0.020/−0.041','φ36 0/−0.6（普通）（ボス外径）'], chamfer:['C1.5 +0.8/0（普通）'], locs:[b1, g1, g2] },
                   { name:'刻印', view:'上側面図', note:'V26C-H', locs:[b1] }],
         dists:[{ nominal:36.2, upper:0.3, lower:-0.3, view:'F-F', note:'普通 HES D0001 2級', locs:[g3] }, { nominal:20, upper:0.06, lower:0.04, view:'F-F', note:'溝幅', locs:[b1] }] },
    drawing:{ fileId:'GENFILE', name:'GD-1_GENDRAW.pdf' } };
  await pg.click('text=JSONから取込'); await pg.fill('textarea', JSON.stringify(j)); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(600);
  const sp = () => pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')).find(p => p.drawingNo === 'GD-1'));
  let p = await sp();
  ok('G6 取込で案件の規格（gen）と位置の普通公差フラグ（g:1）が保存される', p.gen === S && p.nc.features[0].locs[1].g === 1 && !('g' in p.nc.features[0].locs[0]) && p.dims[0].locs[0].g === 1 && p.nc.dists[0].locs[0].g === 1, JSON.stringify([p.gen, p.nc.features[0].locs]));
  await camTab(pg); await pg.waitForTimeout(300);
  const op = await pg.$('button:text-is("図面を開く")'); if (op) await op.click(); await pg.waitForTimeout(3000);
  const band = await pg.$eval('.gen-std', e => e.innerText).catch(() => '');
  ok('G7 CAMタブの一覧の上に「普通公差 HES D 0001-08 2級 適用」の帯', /普通公差 HES D 0001-08 2級 適用/.test(band), band);
  const gv = await pg.$$eval('.gen-badge', b => b.map(x => x.previousElementSibling ? x.previousElementSibling.textContent : ''));
  ok('G8 普通公差で決まる値ごとに「普通」の印（大端ボアの φ36・C1.5、距離 36.2 の3つ）、普通でない値（φ24 R7・20 溝幅）には付かない', gv.length === 3 && gv[0] === 'φ36 0/−0.6（ボス外径）' && gv[1] === 'C1.5 +0.8/0' && /^36\.2 \+0\.3\/[-−]0\.3/.test(gv[2]) && !gv.some(t => /φ24|^溝幅/.test(t)), JSON.stringify(gv));
  const frames1 = (await pg.$$('.drw-gen')).length;
  ok('G9 図面上の普通公差の箇所に常に点線枠（1ページ目：重複を除き2か所）', frames1 === 2, String(frames1));
  await pg.click('.cam-row:has(span:text-is("刻印"))'); await pg.waitForTimeout(1500);
  ok('G10 カードを選ぶと赤枠が出て、点線枠はそのまま', (await pg.$$('.drw-hl')).length === 1 && (await pg.$$('.drw-gen')).length === 2);
  await pg.click('.cam-row:has-text("36.2")'); await pg.waitForTimeout(1800);
  const lbl = await pg.textContent('text=/ページ/').catch(() => '');
  ok('G11 2ページ目に移ると、そのページの点線枠だけ（1か所）', /^2 \//.test(lbl) && (await pg.$$('.drw-gen')).length === 1, lbl + ' ' + (await pg.$$('.drw-gen')).length);
  // re-import into the existing project: gen and flags are updated with the CAM data, dims / measurements kept
  await pg.click('button[aria-label="戻る"], button:has-text("←")').catch(() => {});
  await pg.evaluate(() => { location.reload(); }); await pg.waitForTimeout(800);
  const j2 = JSON.parse(JSON.stringify(j)); j2.gen = 'HES D 0001-08 1級'; j2.nc.features[0].locs = [b1, g1];
  await pg.click('text=JSONから取込'); await pg.fill('textarea', JSON.stringify(j2)); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(800);
  p = await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')).filter(p => p.drawingNo === 'GD-1'));
  ok('G12 同じ図番に貼り直すと規格と点線枠のフラグも更新（案件は増えない）', p.length === 1 && p[0].gen === 'HES D 0001-08 1級' && p[0].nc.features[0].locs.length === 2 && p[0].dims.length === 2, p.length + ' ' + (p[0] && p[0].gen));
  // CAM cards: every tolerance of a feature in one card; distances with f sit in that feature's card
  const k = { partName:'CAMCARD', drawingNo:'CC-1', gen:S,
    nc:{ features:[{ name:'小端 二股（溝）', view:'正面図', qty:2, dia:['φ10.1 +0.1/0'], depth:['12'], chamfer:['C1 +0.8/0（普通）','R0.5 0/−0.4（普通）'], gdt:['位置度 φ0.1'], rough:'Ra1.6', note:'両側', locs:[{p:1,x:0.2,y:0.2,w:0.03,h:0.02}] }],
         dists:[{ nominal:20, upper:0.06, lower:0.04, view:'正面図', note:'溝幅', f:'小端 二股（溝）', locs:[{p:2,x:0.4,y:0.4,w:0.03,h:0.02}] },
                { nominal:2.3, upper:0.1, lower:0, view:'正面図', f:'存在しない形状', locs:[{p:1,x:0.7,y:0.7,w:0.03,h:0.02}] }] } };
  await pg.evaluate(() => { location.reload(); }); await pg.waitForTimeout(800);
  await pg.click('text=JSONから取込'); await pg.fill('textarea', JSON.stringify(k)); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(800);
  await feat(pg);
  p = await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')).find(p => p.drawingNo === 'CC-1'));
  ok('K1 距離の f（所属する形状名）が保存される', p && p.nc.dists[0].f === '小端 二股（溝）' && p.nc.dists[1].f === '存在しない形状', JSON.stringify(p && p.nc.dists.map(x => x.f)));
  const cards = await pg.$$eval('.cam-row', e => e.map(x => x.innerText));
  ok('K2 取込後はCAMタブが開き、形状のカード1枚＋所属先のない距離のカード1枚', cards.length === 2 && /^小端 二股（溝）/.test(cards[0]) && /2\.3/.test(cards[1]) && !/2\.3/.test(cards[0]), JSON.stringify(cards));
  ok('K3 形状のカードに全公差（径・深さ・面取り・R・位置度・粗さ・距離・注記・個数・図）', ['径', 'φ10.1 +0.1/0', '深さ', '12', '面取り・R', 'C1 +0.8/0', 'R0.5 0/−0.4', '位置度 φ0.1', 'Ra1.6', '距離', '溝幅 20 +0.06/+0.04', '両側', '×2', '正面図'].every(t => cards[0].includes(t)), cards[0]);
  ok('K4 面取り・R の普通公差の値に「普通」の印（2つ）', (await pg.$eval('.cam-row', e => e.querySelectorAll('.gen-badge').length)) === 2);
  await (await pg.$$('.cam-row >> nth=1 >> .cam-chk'))[0].check(); await pg.waitForTimeout(700);
  p = await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')).find(p => p.drawingNo === 'CC-1'));
  ok('K5 距離だけのカードのチェック欄は距離に保存（形状の値は済みにならない）', p.nc.dists[1].chk === true && p.nc.features[0].chks.length === 0, JSON.stringify([p.nc.features[0].chks, p.nc.dists[1].chk]));
  await pg.click('.cam-row >> nth=0'); await pg.waitForTimeout(300);
  ok('K6 図面が未紐づけでもカードは選べ、位置なしの表示は出ない（形状＋所属距離の位置を合わせて持つ）', (await pg.$$eval('.cam-row', e => e.filter(x => x.style.background).length)) === 1 && !(await pg.$('.cam-row:has-text("位置なし")')) && (await pg.evaluate(() => /「図面を選ぶ」/.test(document.body.innerText))));
  await pg.close();
  return R;
}

async function valueSelTests(browser, html, errs) {
  // v2.13.0: each value in a CAM card is tapped on its own and shows only its own place (locs[].v); the card name only moves the drawing
  const pg = await open(browser, html, 1180, 820, errs, 'valsel');
  const st = path.join(__dirname, 'stubs'), fx = path.join(__dirname, 'fixtures');
  await pg.route(/accounts\.google\.com\/gsi\/client/, r => r.fulfill({ path:path.join(st,'gsi.js'), contentType:'application/javascript' }));
  await pg.route(/apis\.google\.com\/js\/api\.js/, r => r.fulfill({ path:path.join(st,'picker.js'), contentType:'application/javascript' }));
  await pg.route(/googleapis\.com\/drive\/v3\/files/, r => r.fulfill({ path:path.join(fx,'test_drawing.pdf'), contentType:'application/pdf' }));
  await pg.goto('file://' + path.resolve(html)); await pg.waitForTimeout(300);
  const R = [], ok = (n, c, i) => R.push(`${c ? 'OK ' : 'NG '} ${n}${i ? '  ' + i : ''}`);
  const B = (p, x, y, v) => Object.assign({ p, x, y, w:0.04, h:0.02 }, v ? { v } : {});
  const j = { partName:'VALSEL', drawingNo:'VS-1',
    nc:{ features:[{ name:'ねじ穴', view:'V', qty:2, dia:['φ16 0/−0.6（普通）'], thread:'M10', chamfer:['C1.5 +0.8/0（普通）','R2 0/−0.8（普通）'], gdt:['⊕φ0.1 A B'], note:'注記X',
                     locs:[B(2,0.5,0.5,'dia:0'), B(1,0.1,0.1,'thread'), B(1,0.3,0.3,'chamfer:0'), B(1,0.32,0.6,'chamfer:0'), B(1,0.6,0.2,'chamfer:1'), B(1,0.7,0.7,'note')] },
                   { name:'旧形状', view:'W', dia:['φ5'], chamfer:['C1'], locs:[B(1,0.2,0.4), B(1,0.25,0.45), B(1,0.3,0.5)] }],
         dists:[{ nominal:20, upper:0.06, lower:0.04, f:'ねじ穴', note:'溝幅', locs:[B(1,0.4,0.8)] }] },
    drawing:{ fileId:'VFILE', name:'VS-1.pdf' } };
  await pg.click('text=JSONから取込'); await pg.fill('textarea', JSON.stringify(j)); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(700);
  const p = await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')).find(p => p.drawingNo === 'VS-1'));
  ok('V1 取込で位置の「どの値か」(v) が保存される（v のない位置には付けない）', p.nc.features[0].locs.map(b => b.v).join() === 'dia:0,thread,chamfer:0,chamfer:0,chamfer:1,note' && p.nc.features[1].locs.every(b => !('v' in b)), JSON.stringify(p.nc.features[0].locs.map(b => b.v)));
  await camTab(pg); await pg.waitForTimeout(300);
  const op = await pg.$('button:text-is("図面を開く")'); if (op) await op.click(); await pg.waitForSelector('canvas', { timeout:10000 }).catch(() => {}); await pg.waitForTimeout(500);
  const st0 = () => pg.evaluate(() => ({ boxes:document.querySelectorAll('.drw-hl').length, lbl:(document.body.innerText.match(/\d+ \/ \d+ ページ/) || [''])[0],
    vals:[...document.querySelectorAll('.cam-val')].filter(e => e.style.background).map(e => e.textContent), cards:[...document.querySelectorAll('.cam-row')].filter(e => e.style.background).length }));
  const tap = async sel => { await pg.click(sel); await pg.waitForTimeout(1500); return st0(); };
  let s = await tap('.cam-row:has-text("ねじ穴") span:text-is("ねじ穴")');
  ok('V2 形状の名前をタップ → 赤枠は出さず、カードが選ばれ、図面はその形状の場所（2ページ目）へ移る', s.boxes === 0 && s.cards === 1 && s.vals.length === 0 && /^2 \//.test(s.lbl), JSON.stringify(s));
  s = await tap('.cam-val:has-text("C1.5 +0.8/0")');
  ok('V3 値（C1.5）をタップ → その値の場所だけ赤枠（同じ値の2か所）・1ページ目へ・その値だけ青・カードは青にしない', s.boxes === 2 && /^1 \//.test(s.lbl) && s.vals.length === 1 && /^C1\.5/.test(s.vals[0]) && s.cards === 0, JSON.stringify(s));
  s = await tap('.cam-val:has-text("R2 0/−0.8")');
  ok('V4 別の値（R2）をタップ → 赤枠はその1か所だけに替わり、前の値の青は消える', s.boxes === 1 && s.vals.length === 1 && /^R2/.test(s.vals[0]), JSON.stringify(s));
  s = await tap('.cam-val:has-text("溝幅 20")');
  ok('V5 形状に入った距離（f）をタップ → その距離の場所だけ赤枠', s.boxes === 1 && s.vals.length === 1 && /溝幅 20/.test(s.vals[0]), JSON.stringify(s));
  s = await tap('.cam-val:has-text("注記X")');
  ok('V6 注記に位置があればタップでその場所だけ赤枠', s.boxes === 1 && s.vals.length === 1 && s.vals[0] === '注記X', JSON.stringify(s));
  const cur = await pg.$eval('.cam-val:has-text("⊕φ0.1 A B")', e => e.style.cursor);
  s = await tap('.cam-val:has-text("⊕φ0.1 A B")');
  ok('V7 位置のない値は値としては選べない（押すとカードが選ばれるだけ・赤枠なし）', cur !== 'pointer' && s.boxes === 0 && s.cards === 1 && s.vals.length === 0, cur + ' ' + JSON.stringify(s));
  s = await tap('.cam-row:has-text("旧形状") span:text-is("旧形状")');
  ok('V8 位置に値の印がない古いデータ → カードのタップで従来どおりその形状の全部の場所に赤枠', s.boxes === 3 && s.cards === 1, JSON.stringify(s));
  await tap('.cam-val:has-text("R2 0/−0.8")');
  await pg.click('button:text-is("測定")'); await pg.waitForTimeout(300); await camTab(pg); await pg.waitForSelector('.drw-hl', { timeout:10000 }).catch(() => {}); await pg.waitForTimeout(500);
  s = await st0();
  ok('V9 他のタブへ行って戻っても、選んだ値と赤枠はそのまま', s.boxes === 1 && s.vals.length === 1 && /^R2/.test(s.vals[0]), JSON.stringify(s));
  await pg.close();
  return R;
}

async function camCheckTests(browser, html, errs) {
  // v2.14.0: a CAM check per value (done), progress per feature, checks survive re-import, target (middle) values
  const pg = await open(browser, html, 1180, 820, errs, 'camcheck');
  pg.removeAllListeners('dialog'); pg.on('dialog', d => d.accept());
  await pg.goto('file://' + path.resolve(html)); await pg.waitForTimeout(300);
  const R = [], ok = (n, c, i) => R.push(`${c ? 'OK ' : 'NG '} ${n}${i ? '  ' + i : ''}`);
  const F = { name:'ボア', view:'A', dia:['φ24 R7 −0.020/−0.041', 'φ47 P7', '6xC0.3±0.2'], depth:['8±0.2', '12'], thread:'M10×1.25', chamfer:['C1.5 +0.8/0（普通）', 'R4（TRUE）0/−0.8（4か所）（普通）'], gdt:['⊕φ0.1 A B'], rough:'Rz12.5', note:'注記',
              locs:[{ p:1, x:0.1, y:0.1, w:0.03, h:0.02, v:'dia:0' }] };
  const base = { partName:'CHK', drawingNo:'CK-1', nc:{ features:[F, { name:'穴B', dia:['φ5 +0.1/0'] }], dists:[{ nominal:20, upper:0.06, lower:0.04, f:'ボア', note:'溝幅', locs:[{ p:1, x:0.5, y:0.5, w:0.03, h:0.02 }] }, { nominal:3, upper:0, lower:-0.1 }] } };
  const imp = async j => { if (await pg.$('text=←')) { await pg.click('text=←'); await pg.waitForTimeout(300); } await pg.click('text=JSONから取込'); await pg.fill('textarea', JSON.stringify(j)); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(800); await feat(pg); };
  const proj = () => pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')).find(p => p.drawingNo === 'CK-1'));
  const progs = () => pg.$$eval('.cam-prog', e => e.map(x => x.textContent));
  await imp(base);
  const card0 = '.cam-row >> nth=0';
  const n0 = (await pg.$$(card0 + ' >> .cam-chk')).length;
  ok('W1 値ごとにチェック欄（径3・深さ2・ねじ・面取り2・位置度・粗さ・形状に入った距離 = 11）、形状名の横に「済み 0/11」', n0 === 11 && (await progs())[0] === '済み 0/11', n0 + ' ' + JSON.stringify(await progs()));
  ok('W2 値が1つだけのカード（穴B・距離 3）には済み数を出さない', (await progs()).length === 1, JSON.stringify(await progs()));
  const bx = await pg.$$(card0 + ' >> .cam-chk');
  await pg.click('.cam-val:has-text("φ24 R7")'); await pg.waitForTimeout(300);
  const sel0 = await pg.evaluate(() => DRW.sel);
  await bx[0].check(); await bx[3].check(); await bx[10].check(); await pg.waitForTimeout(700);
  let p = await proj();
  ok('W3 チェックは値ごとに保存（φ24 R7・深さ 8・距離 20）、形状名の横は「済み 3/11」', JSON.stringify(p.nc.features[0].chks) === JSON.stringify(['dia|φ24 R7 −0.020/−0.041', 'depth|8±0.2']) && p.nc.dists[0].chk === true && (await progs())[0] === '済み 3/11', JSON.stringify([p.nc.features[0].chks, p.nc.dists[0].chk, await progs()]));
  ok('W4 チェック欄を押しても選んでいる値（赤枠）は変わらない', await pg.evaluate(() => DRW.sel) === sel0 && sel0 != null);
  for (const b of await pg.$$(card0 + ' >> .cam-chk')) await b.check();
  await pg.waitForTimeout(500);
  const pr = (await progs())[0], col = await pg.$eval('.cam-prog', e => getComputedStyle(e).color);
  ok('W5 全部チェックすると「✓ 済み 11/11」（緑）', pr === '✓ 済み 11/11' && col === 'rgb(19, 115, 51)', pr + ' ' + col);
  // re-import: unchanged values keep their check, a changed value loses it
  const j2 = JSON.parse(JSON.stringify(base)); j2.nc.features[0].chamfer[0] = 'C1.5 +0.5/0（普通）'; j2.nc.dists[0].upper = 0.07;
  await imp(j2); p = await proj();
  ok('W6 同じ図番に貼り直してもチェックは残り、書き方の変わった値（C1.5 の公差・距離 20 の上限）だけ外れる', p.nc.features[0].chks.length === 9 && !p.nc.features[0].chks.includes('chamfer|C1.5 +0.5/0（普通）') && p.nc.dists[0].chk !== true && (await progs())[0] === '済み 9/11', JSON.stringify(await progs()));
  await pg.click('button:text-is("CAMデータ取込")'); await pg.fill('textarea', JSON.stringify({ nc:base.nc })); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(700);
  p = await proj();
  ok('W7 CAMタブの「CAMデータ取込」で置き換えてもチェックは残る', p.nc.features[0].chks.length === 9 && (await progs())[0] === '済み 9/11', JSON.stringify(await progs()));
  const mids = await pg.$$eval('.cam-mid', e => e.map(x => x.textContent));
  const want = ['中央 φ23.9695', '中央 φ46.9705', '中央 C0.3', '中央 8', '中央 C1.9', '中央 R3.6', '中央 20.05', '中央 φ5.05', '中央 2.95'];
  ok('W8 中央値（数値公差・公差域クラスのJIS計算・±・個数付き・括弧の注記つき・距離）。ねじ・位置度・粗さ・公差のない深さには出さない', JSON.stringify(mids) === JSON.stringify(want), JSON.stringify(mids));
  // data saved by v2.13.0 or older: one check per feature → all of its values done
  await pg.evaluate(() => { const a = JSON.parse(localStorage.getItem('_projects')); const q = a.find(p => p.drawingNo === 'CK-1'); q.nc.features.forEach(f => { delete f.chks; }); q.nc.features[1].chk = true; localStorage.setItem('_projects', JSON.stringify(a)); });
  await pg.goto('file://' + path.resolve(html)); await pg.waitForTimeout(400); await pg.click('text=CHK'); await pg.waitForTimeout(500); await camTab(pg); await pg.waitForTimeout(400);
  const c1b = await pg.$$eval('.cam-row', e => [...e[1].querySelectorAll('.cam-chk')].map(x => x.checked));
  ok('W9 v2.13.0 までの形状ごとのチェックは、その形状の値が全部済みとして引き継ぐ', c1b.length === 1 && c1b[0] === true, JSON.stringify(c1b));
  await pg.close();
  return R;
}

async function mouseTests(browser, html, errs) {
  // v2.15.0: PC mouse on the drawing — right-button drag moves it, the wheel zooms around the pointer, no browser menu, left click unchanged
  const pg = await open(browser, html, 1180, 820, errs, 'mouse');
  const st = path.join(__dirname, 'stubs'), fx = path.join(__dirname, 'fixtures');
  await pg.route(/accounts\.google\.com\/gsi\/client/, r => r.fulfill({ path:path.join(st,'gsi.js'), contentType:'application/javascript' }));
  await pg.route(/apis\.google\.com\/js\/api\.js/, r => r.fulfill({ path:path.join(st,'picker.js'), contentType:'application/javascript' }));
  await pg.route(/googleapis\.com\/drive\/v3\/files/, r => r.fulfill({ path:path.join(fx,'test_drawing.pdf'), contentType:'application/pdf' }));
  await pg.goto('file://' + path.resolve(html)); await pg.waitForTimeout(300);
  const R = [], ok = (n, c, i) => R.push(`${c ? 'OK ' : 'NG '} ${n}${i ? '  ' + i : ''}`);
  const j = { partName:'MOUSE', drawingNo:'MS-1', nc:{ features:[{ name:'穴A', dia:['φ10 +0.1/0'], locs:[{ p:1, x:0.5, y:0.5, w:0.04, h:0.02, v:'dia:0' }] }], dists:[] }, drawing:{ fileId:'MFILE', name:'MS-1.pdf' } };
  await pg.click('text=JSONから取込'); await pg.fill('textarea', JSON.stringify(j)); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(700);
  await camTab(pg); await pg.waitForTimeout(300);
  const op = await pg.$('button:text-is("図面を開く")'); if (op) await op.click(); await pg.waitForSelector('canvas', { timeout:10000 }).catch(() => {}); await pg.waitForTimeout(600);
  const V = () => pg.evaluate(() => { const v = document.querySelector('canvas').parentElement.parentElement, r = v.getBoundingClientRect(); return { sl:v.scrollLeft, st:v.scrollTop, l:r.left, t:r.top, w:r.width, h:r.height, scale:DRW.scale, menu:window.__menu === true }; });
  // start from a zoomed-in view so the drawing can move both ways
  await pg.click('button:text-is("＋")'); await pg.waitForTimeout(1200); await pg.click('button:text-is("＋")'); await pg.waitForTimeout(1500);
  let v0 = await V();
  await pg.evaluate(() => { const v = document.querySelector('canvas').parentElement.parentElement; v.scrollLeft = 400; v.scrollTop = 400; addEventListener('contextmenu', e => { window.__menu = !e.defaultPrevented; }); });
  v0 = await V();
  const cx = v0.l + v0.w / 2, cy = v0.t + v0.h / 2;
  await pg.mouse.move(cx, cy); await pg.mouse.down({ button:'right' }); await pg.mouse.move(cx - 60, cy - 40, { steps:6 }); await pg.mouse.move(cx - 120, cy - 80, { steps:6 }); await pg.mouse.up({ button:'right' });
  await pg.waitForTimeout(300);
  let v1 = await V();
  ok('X1 右ボタンを押したままドラッグ → 図面がドラッグした分だけ動く（右下へ120・80px 送ると表示位置が +120・+80）', Math.abs((v1.sl - v0.sl) - 120) <= 2 && Math.abs((v1.st - v0.st) - 80) <= 2, JSON.stringify([v0.sl, v0.st, v1.sl, v1.st]));
  await pg.mouse.click(cx, cy, { button:'right' }); await pg.waitForTimeout(200);
  ok('X2 図面の上で右クリックしてもブラウザのメニューは出さない', (await V()).menu === false);
  await pg.mouse.move(cx, cy); await pg.mouse.down(); await pg.mouse.move(cx - 100, cy - 100, { steps:5 }); await pg.mouse.up(); await pg.waitForTimeout(200);
  const v2 = await V();
  ok('X3 左ボタンのドラッグでは図面は動かない（左は選ぶ操作のまま）', v2.sl === v1.sl && v2.st === v1.st, JSON.stringify([v1.sl, v1.st, v2.sl, v2.st]));
  // wheel: the drawing point under the pointer stays under the pointer
  const mx = v0.l + 300, my = v0.t + 250;
  const pt = () => pg.evaluate(([mx, my]) => { const v = document.querySelector('canvas').parentElement.parentElement, pg = document.querySelector('canvas').parentElement, r = v.getBoundingClientRect();
    return { fx:(v.scrollLeft + mx - r.left - pg.offsetLeft) / DRW.cv.w, fy:(v.scrollTop + my - r.top - pg.offsetTop) / DRW.cv.h, scale:DRW.scale, w:DRW.cv.w }; }, [mx, my]);
  const a = await pt();
  await pg.mouse.move(mx, my); await pg.mouse.wheel(0, -100); await pg.waitForTimeout(60); await pg.mouse.wheel(0, -100); await pg.waitForTimeout(1800);
  const b = await pt();
  ok('X4 ホイールを奥へ2目盛 → 1.44倍に拡大、マウスの下の図面の点はそのまま', Math.abs(b.scale / a.scale - 1.44) < 0.01 && Math.abs((b.fx - a.fx) * b.w) < 3 && Math.abs((b.fy - a.fy) * b.w) < 3, JSON.stringify([a, b]));
  await pg.mouse.wheel(0, 100); await pg.waitForTimeout(1800);
  const c = await pt();
  ok('X5 ホイールを手前へ1目盛 → 1/1.2 に縮小', Math.abs(c.scale / b.scale - 1 / 1.2) < 0.01, JSON.stringify([b.scale, c.scale]));
  for (let i = 0; i < 40; i++) await pg.mouse.wheel(0, 100);
  await pg.waitForTimeout(1800);
  ok('X6 縮小は下限 0.3 で止まる', Math.abs((await pt()).scale - 0.3) < 0.001, String((await pt()).scale));
  await pg.click('.cam-val:has-text("φ10 +0.1/0")'); await pg.waitForTimeout(1500);
  ok('X7 左クリックで値を選ぶと、今までどおりその場所に赤枠', (await pg.$$('.drw-hl')).length === 1);
  await pg.close();
  return R;
}

async function modTests(browser, html, errs) {
  // v2.16.0: CAM tab "モデル修正" — one-sided / asymmetric distances and shafts to remodel to the middle value, numbered on the drawing
  const pg = await open(browser, html, 1180, 820, errs, 'mod');
  const st = path.join(__dirname, 'stubs'), fx = path.join(__dirname, 'fixtures');
  await pg.route(/accounts\.google\.com\/gsi\/client/, r => r.fulfill({ path:path.join(st,'gsi.js'), contentType:'application/javascript' }));
  await pg.route(/apis\.google\.com\/js\/api\.js/, r => r.fulfill({ path:path.join(st,'picker.js'), contentType:'application/javascript' }));
  await pg.route(/googleapis\.com\/drive\/v3\/files/, r => r.fulfill({ path:path.join(fx,'test_drawing.pdf'), contentType:'application/pdf' }));
  pg.removeAllListeners('dialog'); pg.on('dialog', d => d.accept());
  await pg.goto('file://' + path.resolve(html)); await pg.waitForTimeout(300);
  const R = [], ok = (n, c, i) => R.push(`${c ? 'OK ' : 'NG '} ${n}${i ? '  ' + i : ''}`);
  const L = (x, y) => [{ p:1, x, y, w:0.02, h:0.03 }];
  const j = { partName:'MOD', drawingNo:'MD-1',
    dims:[{ name:'φ20', nominal:20, upper:-0.02, lower:-0.041, type:'軸', locs:L(0.3, 0.5) }, { name:'φ30', nominal:30, upper:0.1, lower:0, type:'穴', locs:L(0.6, 0.5) }],
    nc:{ features:[{ name:'段', depth:['57.5 +0.2/0', '66.1 0/−0.2'] }],
         dists:[{ nominal:66.1, upper:0, lower:-0.2, view:'A-A', note:'0面から', locs:L(0.4, 0.7) }, { nominal:57.5, upper:0.2, lower:0, view:'A-A', note:'0面から', locs:L(0.4, 0.2) }, { nominal:10, upper:0.1, lower:-0.1, locs:L(0.8, 0.8) }] },
    drawing:{ fileId:'MDFILE', name:'MD-1.pdf' } };
  await pg.click('text=JSONから取込'); await pg.fill('textarea', JSON.stringify(j)); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(700);
  await pg.click('button:text-matches("^CAM")'); await pg.waitForTimeout(300);
  const op = await pg.$('button:text-is("図面を開く")'); if (op) await op.click(); await pg.waitForSelector('canvas', { timeout:10000 }).catch(() => {}); await pg.waitForTimeout(800);
  const rows = await pg.$$eval('.mod-row', e => e.map(x => x.innerText.replace(/\s+/g, ' ').trim()));
  const seg = await pg.$$eval('.cam-seg', e => e.map(x => x.textContent + (x.style.background.includes('255') ? '*' : '')));
  ok('Y1 CAMタブは「モデル修正」から開き、片側・非対称の距離と軸だけ（±の距離・穴は出さない）を図面の上から順に番号', rows.length === 3 && /^1 距離 57\.5/.test(rows[0]) && /^2 軸 φ20/.test(rows[1]) && /^3 距離 66\.1/.test(rows[2]) && seg[0] === 'モデル修正 0/3*' && seg[1] === '形状ごと', JSON.stringify([seg, rows]));
  ok('Y2 各行に「図面の値 → 中央値（動かす量）」', /57\.5 \+0\.2\/0 → 57\.6 （\+0\.1）/.test(rows[0]) && /φ20 -0\.02\/-0\.041 → φ19\.9695 （−0\.0305）/.test(rows[1]) && /66\.1 0\/-0\.2 → 66 （−0\.1）/.test(rows[2]), JSON.stringify(rows));
  const pins = () => pg.$$eval('.mod-pin', e => e.map(x => ({ t:x.innerText.replace(/\s+/g, ' ').trim(), red:x.style.borderColor.includes('217') || x.style.border.includes('rgb(217'), green:x.style.border.includes('rgb(24') })));
  let pn = await pins();
  ok('Y3 図面には対象全部に番号と枠（未は赤）、中央値はまだ出さない', pn.length === 3 && pn.map(x => x.t).sort().join() === '1,2,3' && pn.every(x => x.red) && (await pg.$$('.mod-box')).length === 3 && (await pg.$$('.mod-pin-mid')).length === 0, JSON.stringify(pn));
  await pg.click('.mod-row:has-text("66.1")'); await pg.waitForTimeout(1500);
  pn = await pins();
  ok('Y4 一覧の行を押す → その1つだけ図面に「番号＋中央値＋動かす量」の札と赤枠', (await pg.$$eval('.mod-pin-dlt', e => e.map(x => x.textContent))).join() === '（−0.1）' && (await pg.$$eval('.mod-pin-mid', e => e.map(x => x.textContent))).join() === '66' && pn.filter(x => / /.test(x.t)).length === 1 && (await pg.$$('.drw-hl')).length === 1, JSON.stringify(pn));
  await pg.click('.mod-pin:has(.mod-pin-no:text-is("1"))'); await pg.waitForTimeout(1500);
  const selRow = await pg.$$eval('.mod-row', e => e.findIndex(x => x.style.background));
  ok('Y5 図面の番号を押す → 一覧のその行が選ばれ、札がその値（57.6（+0.1））に替わる', selRow === 0 && (await pg.$$eval('.mod-pin-mid', e => e.map(x => x.textContent))).join() === '57.6' && (await pg.$$eval('.mod-pin-dlt', e => e.map(x => x.textContent))).join() === '（+0.1）', String(selRow));
  const sel0 = await pg.evaluate(() => DRW.sel);
  await (await pg.$$('.mod-chk'))[0].check(); await (await pg.$$('.mod-chk'))[1].check(); await pg.waitForTimeout(800);
  const pr = await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')).find(p => p.drawingNo === 'MD-1'));
  pn = await pins();
  const seg2 = await pg.$eval('.cam-seg', e => e.textContent);
  ok('Y6 チェックで済み（距離は距離に、軸は寸法に保存）・図面の番号が緑・「モデル修正 2/3」・選んでいる行は変わらない', pr.nc.dists.find(x => x.nominal === 57.5).chk === true && pr.dims.find(x => x.name === 'φ20').camChk === true && pn.filter(x => x.green).length === 2 && seg2 === 'モデル修正 2/3' && await pg.evaluate(() => DRW.sel) === sel0, JSON.stringify([seg2, pn]));
  await pg.click('.cam-seg:has-text("形状ごと")'); await pg.waitForTimeout(600);
  const cards = await pg.$$eval('.cam-row', e => e.map(x => x.innerText.slice(0, 12)));
  const c57 = await pg.$$eval('.cam-row', e => { const c = e.find(x => /57\.5 \+0\.2\/0（/.test(x.innerText)); return c ? c.querySelector('.cam-chk').checked : null; });
  ok('Y7 「形状ごと」に切り替えると従来のカード（モデル修正の番号は図面に出さない）、距離のチェックは共有', cards.length >= 3 && c57 === true && (await pg.$$('.mod-pin')).length === 0, JSON.stringify([cards, c57]));
  await pg.click('.cam-seg:has-text("モデル修正")'); await pg.waitForTimeout(600);
  ok('Y8 「モデル修正」に戻ると一覧と番号が戻る', (await pg.$$('.mod-row')).length === 3 && (await pg.$$('.mod-pin')).length === 3);
  // a job without CAM data: shafts only, no switch
  const j2 = { partName:'MOD2', drawingNo:'MD-2', dims:[{ name:'φ12', tClass:'g6', nominal:12, upper:-0.006, lower:-0.017, type:'軸' }, { name:'φ8', nominal:8, upper:0.02, lower:0, type:'穴' }] };
  await pg.click('text=←'); await pg.waitForTimeout(300);
  await pg.click('text=JSONから取込'); await pg.fill('textarea', JSON.stringify(j2)); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(700);
  await pg.click('button:text-matches("^CAM")'); await pg.waitForTimeout(500);
  const r2 = await pg.$$eval('.mod-row', e => e.map(x => x.innerText.replace(/\s+/g, ' ').trim()));
  ok('Y9 CAMデータのない案件でも軸はモデル修正に出る（切替なし・位置がなければ「図面に位置なし」）', r2.length === 1 && /φ12 g6 -0\.006\/-0\.017 → φ11\.9885/.test(r2[0]) && /図面に位置なし/.test(r2[0]) && (await pg.$$('.cam-seg')).length === 1, JSON.stringify(r2));
  // v2.17.0: one-sided general-tolerance shafts (not measured) kept as CAM rows with kind "軸"
  const j3 = { partName:'MOD3', drawingNo:'MD-3', gen:'YGK-2-001',
    nc:{ features:[{ name:'ボス', dia:['φ16（普通）'], locs:[{ p:1, x:0.5, y:0.3, w:0.02, h:0.03, v:'dia:0' }] }],
         dists:[{ kind:'軸', nominal:16, upper:0, lower:-0.3, note:'普通 YGK-2-001', f:'ボス', locs:[{ p:1, x:0.5, y:0.3, w:0.02, h:0.03, g:1 }] }, { nominal:5, upper:0.2, lower:0, locs:[{ p:1, x:0.2, y:0.6, w:0.02, h:0.03 }] }] } };
  await pg.click('text=←'); await pg.waitForTimeout(300);
  await pg.click('text=JSONから取込'); await pg.fill('textarea', JSON.stringify(j3)); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(700);
  await pg.click('button:text-matches("^CAM")'); await pg.waitForTimeout(500);
  const r3 = await pg.$$eval('.mod-row', e => e.map(x => x.innerText.replace(/\s+/g, ' ').trim()));
  const st3 = await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')).find(p => p.drawingNo === 'MD-3').nc.dists.map(d => d.kind || ''));
  ok('Y10 CAMデータの「軸」の行（普通公差の片側の軸）を取込んで保存し、モデル修正に「軸 φ16 0/-0.3 普通 → φ15.85（−0.15）」で出す', st3.join() === '軸,' && r3.length === 2 && /軸 φ16 0\/-0\.3 普通 → φ15\.85 （−0\.15）/.test(r3[0]) && /距離 5 \+0\.2\/0 → 5\.1/.test(r3[1]), JSON.stringify([st3, r3]));
  await (await pg.$$('.mod-chk'))[0].check(); await pg.waitForTimeout(500);
  await pg.click('.cam-seg:has-text("形状ごと")'); await pg.waitForTimeout(500);
  const c3 = await pg.$$eval('.cam-row', e => e.map(x => x.innerText.replace(/\s+/g, ' ')));
  const ck3 = await pg.$eval('.cam-row', e => [...e.querySelectorAll('.cam-chk')].map(x => x.checked));
  ok('Y11 形状ごとでは、その形状のカードに「軸径 φ16 …（普通）」で入り、チェックは共有', /軸径 φ16 0\/-0\.3（15\.7〜16）/.test(c3[0]) && /中央 φ15\.85/.test(c3[0]) && ck3.join() === 'false,true', JSON.stringify([c3[0], ck3]));
  await pg.click('text=←'); await pg.waitForTimeout(300);
  await pg.click('text=JSONから取込'); await pg.fill('textarea', JSON.stringify(j3)); await pg.click('button:text-is("取込")'); await pg.waitForTimeout(700);
  const kept = await pg.evaluate(() => JSON.parse(localStorage.getItem('_projects')).find(p => p.drawingNo === 'MD-3').nc.dists[0].chk);
  ok('Y12 貼り直しても「軸」の行のチェックは残る', kept === true, String(kept));
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
  console.log('== CAMタブの普通公差・カードの試験（改修後）');
  for (const r of await genDrawTests(browser, newHtml, errs)) console.log(r);
  console.log('== CAMタブ モデル修正の試験（改修後）');
  for (const r of await modTests(browser, newHtml, errs)) console.log(r);
  console.log('== 図面のマウス操作の試験（改修後）');
  for (const r of await mouseTests(browser, newHtml, errs)) console.log(r);
  console.log('== CAMの値ごとのチェック・中央値の試験（改修後）');
  for (const r of await camCheckTests(browser, newHtml, errs)) console.log(r);
  console.log('== CAMカードの値ごとの選択の試験（改修後）');
  for (const r of await valueSelTests(browser, newHtml, errs)) console.log(r);
  console.log('== 普通公差の印の試験（改修後）');
  for (const r of await genTests(browser, newHtml, errs)) console.log(r);
  console.log('== 図面試験（CAMタブ・測定タブ・縦横）（改修後）');
  for (const r of await drawingTests(browser, newHtml, errs)) console.log(r);
  console.log('== 成績書の番号付き図面試験（改修後）');
  for (const r of await reportSheetTests(browser, newHtml, errs)) console.log(r);
  console.log('== 一覧の読込試験（同期モード・Firebaseは tools/stubs で差し替え）');
  for (const r of await cloudListTests(browser, newHtml, errs)) console.log(r);
  console.log('== ページエラー'); console.log(errs.length ? errs.join('\n') : 'none');
  await browser.close();
})();
