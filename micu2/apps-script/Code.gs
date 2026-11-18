/**
 * MICU 2 เวลาเข้า-ออกงาน — ระบบลงเวลาพยาบาล หอผู้ป่วย MICU 2(240)
 * Backend: Google Apps Script + Google Sheets
 *
 * วิธีติดตั้งโดยย่อ (ดูรายละเอียดใน micu2/README.md)
 * 1) สร้าง Google Sheet ใหม่ > ส่วนขยาย > Apps Script
 * 2) วางโค้ดไฟล์นี้ลงใน Code.gs แล้วบันทึก
 * 3) เลือกฟังก์ชัน setup แล้วกด "เรียกใช้" (อนุญาตสิทธิ์ครั้งแรก)
 * 4) ทำให้ใช้งานได้ > การทำให้ใช้งานได้รายการใหม่ > เว็บแอป
 *    - เรียกใช้ในฐานะ: ฉัน   - ผู้มีสิทธิ์เข้าถึง: ทุกคน
 * 5) คัดลอก URL ที่ลงท้ายด้วย /exec ไปใส่ใน micu2/index.html (ค่า API_URL)
 */

var TZ = 'Asia/Bangkok';
var TZ_OFFSET_MS = 7 * 3600 * 1000; // ประเทศไทยไม่มี DST

var SHEET_SETTINGS = 'ตั้งค่า';
var SHEET_STAFF = 'รายชื่อพยาบาล';
var SHEET_LOG = 'บันทึกเวลา';

var LOG_HEADERS = [
  'รหัสรายการ', 'วันที่เวร', 'เวร', 'รหัสพนักงาน', 'ชื่อ-สกุล',
  'เวลาเข้า', 'สถานะเข้า', 'นาทีสาย', 'ระยะห่างตอนเข้า (ม.)', 'พิกัดตอนเข้า',
  'เวลาออก', 'สถานะออก', 'นาทีออกก่อน', 'ระยะห่างตอนออก (ม.)', 'พิกัดตอนออก',
  'ชั่วโมงทำงาน', 'อุปกรณ์', 'หมายเหตุ'
];
// ตำแหน่งคอลัมน์ (เริ่มที่ 0)
var C = {
  ID: 0, DATE: 1, SHIFT: 2, STAFF_ID: 3, NAME: 4,
  IN: 5, IN_STATUS: 6, LATE_MIN: 7, IN_DIST: 8, IN_LOC: 9,
  OUT: 10, OUT_STATUS: 11, EARLY_MIN: 12, OUT_DIST: 13, OUT_LOC: 14,
  HOURS: 15, DEVICE: 16, NOTE: 17
};

var DEFAULT_SETTINGS = [
  ['WARD_NAME', 'MICU 2(240)', 'ชื่อหอผู้ป่วยที่แสดงบนหน้าเว็บ'],
  ['LAT', '', 'ละติจูดของหอผู้ป่วย (เปิดหน้าเว็บที่หอผู้ป่วย แล้วคัดลอกค่าพิกัดมาวาง)'],
  ['LNG', '', 'ลองจิจูดของหอผู้ป่วย'],
  ['RADIUS_M', 100, 'รัศมีที่อนุญาตให้ลงเวลา (เมตร)'],
  ['LATE_GRACE_MIN', 0, 'ผ่อนผันการมาสาย (นาที) เช่น 0 = เกินเวลาเริ่มเวรถือว่าสาย'],
  ['OPEN_BEFORE_MIN', 120, 'เปิดให้ลงเวลาเข้าได้ก่อนเริ่มเวรกี่นาที'],
  ['MAX_ACCURACY_M', 0, 'ไม่รับพิกัดที่คลาดเคลื่อนเกินกี่เมตร (0 = ไม่จำกัด)'],
  ['SHIFT_M', '08:00-16:00', 'เวลาเวรเช้า'],
  ['SHIFT_A', '16:00-24:00', 'เวลาเวรบ่าย'],
  ['SHIFT_N', '00:00-08:00', 'เวลาเวรดึก'],
  ['ADMIN_PASSWORD', '', 'รหัสผ่านผู้ดูแล สำหรับปุ่ม ⚙️ ในหน้าเว็บ — อย่าแชร์ชีตนี้ให้คนทั่วไป']
];

var SETTING_KEYS_EDITABLE = ['WARD_NAME', 'LAT', 'LNG', 'RADIUS_M', 'LATE_GRACE_MIN', 'OPEN_BEFORE_MIN',
  'MAX_ACCURACY_M', 'SHIFT_M', 'SHIFT_A', 'SHIFT_N'];

var SHIFT_DEFS = [
  { code: 'M', key: 'SHIFT_M', name: 'เช้า' },
  { code: 'A', key: 'SHIFT_A', name: 'บ่าย' },
  { code: 'N', key: 'SHIFT_N', name: 'ดึก' }
];

/* ============================== เว็บ API ============================== */

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'config') return json_(apiConfig_());
    if (p.action === 'status') return json_(apiStatus_(p.id));
    return json_({ ok: true, message: 'MICU 2 attendance API พร้อมใช้งาน' });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'ข้อมูลที่ส่งมาไม่ถูกต้อง' });
  }
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    if (body.action === 'checkin') return json_(apiCheckIn_(body));
    if (body.action === 'checkout') return json_(apiCheckOut_(body));
    if (String(body.action || '').indexOf('admin') === 0) return json_(apiAdmin_(body));
    return json_({ ok: false, error: 'ไม่รู้จักคำสั่ง' });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function apiConfig_() {
  var s = getSettings_();
  return {
    ok: true,
    ward: s.WARD_NAME,
    lat: s.LAT === '' ? null : Number(s.LAT),
    lng: s.LNG === '' ? null : Number(s.LNG),
    radius: Number(s.RADIUS_M) || 100,
    graceMin: Number(s.LATE_GRACE_MIN) || 0,
    openBeforeMin: Number(s.OPEN_BEFORE_MIN) || 120,
    shifts: getShifts_(s),
    staff: getStaff_().filter(function (x) { return x.active; })
      .map(function (x) { return { id: x.id, name: x.name, position: x.position }; }),
    serverTime: Date.now()
  };
}

function apiStatus_(staffId) {
  staffId = String(staffId || '').trim();
  if (!staffId) throw new Error('ไม่พบรหัสพนักงาน');
  var rows = readRecentLog_(1500);
  var mine = rows.filter(function (r) { return String(r.row[C.STAFF_ID]) === staffId; });
  var open = null;
  var now = Date.now();
  for (var i = mine.length - 1; i >= 0; i--) {
    var r = mine[i].row;
    if (!r[C.OUT] && r[C.IN] && now - toMs_(r[C.IN]) < 20 * 3600 * 1000) { open = recordToObj_(r); break; }
  }
  var recent = mine.slice(-6).reverse().map(function (x) { return recordToObj_(x.row); });
  return { ok: true, open: open, recent: recent, serverTime: now };
}

function apiCheckIn_(b) {
  var s = getSettings_();
  var staff = findStaff_(b.id);
  var shifts = getShifts_(s);
  var shift = shifts.filter(function (x) { return x.code === b.shift; })[0];
  if (!shift) throw new Error('กรุณาเลือกเวร');

  var geo = checkGeo_(s, b);
  var now = Date.now();
  var win = findShiftWindow_(shift, now, Number(s.OPEN_BEFORE_MIN) || 120);
  if (!win) {
    throw new Error('ขณะนี้ไม่อยู่ในช่วงเวลาลงเวลาเข้าเวร' + shift.name +
      ' (' + shift.start + '-' + shift.end + ')');
  }

  var rows = readRecentLog_(1500);
  var dup = rows.filter(function (r) {
    return String(r.row[C.STAFF_ID]) === staff.id && ds_(r.row[C.DATE]) === win.date &&
      r.row[C.SHIFT] === shift.name;
  })[0];
  if (dup) throw new Error('คุณลงเวลาเข้าเวร' + shift.name + ' วันที่ ' + thaiDate_(win.date) + ' ไปแล้ว');

  var grace = Number(s.LATE_GRACE_MIN) || 0;
  var lateMin = Math.floor((now - win.start) / 60000);
  var late = lateMin > grace;
  var inStatus = late ? ('สาย ' + lateMin + ' นาที') : 'ตรงเวลา';

  var id = Utilities.getUuid().slice(0, 8);
  var row = new Array(LOG_HEADERS.length).fill('');
  row[C.ID] = id;
  row[C.DATE] = win.date;
  row[C.SHIFT] = shift.name;
  row[C.STAFF_ID] = staff.id;
  row[C.NAME] = staff.name;
  row[C.IN] = new Date(now);
  row[C.IN_STATUS] = inStatus;
  row[C.LATE_MIN] = late ? lateMin : 0;
  row[C.IN_DIST] = geo.distance;
  row[C.IN_LOC] = geo.text;
  row[C.DEVICE] = String(b.ua || '').slice(0, 120);
  logSheet_().appendRow(row);

  return {
    ok: true,
    message: 'ลงเวลาเข้าเวร' + shift.name + ' สำเร็จ',
    record: recordToObj_(row)
  };
}

function apiCheckOut_(b) {
  var s = getSettings_();
  var staff = findStaff_(b.id);
  var geo = checkGeo_(s, b);
  var now = Date.now();

  var sh = logSheet_();
  var rows = readRecentLog_(1500);
  var target = null;
  for (var i = rows.length - 1; i >= 0; i--) {
    var r = rows[i].row;
    if (String(r[C.STAFF_ID]) === staff.id && !r[C.OUT] && r[C.IN] &&
        now - toMs_(r[C.IN]) < 20 * 3600 * 1000) { target = rows[i]; break; }
  }
  if (!target) throw new Error('ไม่พบการลงเวลาเข้างานที่ยังไม่ได้ลงเวลาออก');

  var r = target.row;
  var shift = getShifts_(s).filter(function (x) { return x.name === r[C.SHIFT]; })[0];
  var end = shiftBoundsForDate_(shift, ds_(r[C.DATE])).end;
  var earlyMin = Math.floor((end - now) / 60000);
  var outStatus;
  if (earlyMin > 0) outStatus = 'ออกก่อน ' + earlyMin + ' นาที';
  else if (-earlyMin >= 30) outStatus = 'ออกหลังเวร ' + (-earlyMin) + ' นาที';
  else outStatus = 'ปกติ';

  var hours = Math.round((now - toMs_(r[C.IN])) / 36000) / 100;
  var outVals = [[new Date(now), outStatus, earlyMin > 0 ? earlyMin : 0, geo.distance, geo.text, hours]];
  sh.getRange(target.rowNum, C.OUT + 1, 1, 6).setValues(outVals);

  r[C.OUT] = outVals[0][0]; r[C.OUT_STATUS] = outStatus; r[C.EARLY_MIN] = outVals[0][2];
  r[C.OUT_DIST] = geo.distance; r[C.OUT_LOC] = geo.text; r[C.HOURS] = hours;
  return { ok: true, message: 'ลงเวลาออกเวร' + r[C.SHIFT] + ' สำเร็จ', record: recordToObj_(r) };
}


/* ============================== ผู้ดูแล (ปุ่ม ⚙️ ในหน้าเว็บ) ============================== */

function apiAdmin_(b) {
  var s = getSettings_();
  checkAdmin_(s, b.pw);
  switch (b.action) {
    case 'adminLogin': return { ok: true, settings: adminSettings_(s), staff: getStaff_() };
    case 'adminSaveSettings': return adminSaveSettings_(b.values || {});
    case 'adminSaveStaff': return adminSaveStaff_(b.staff || {});
    case 'adminDay': return adminDay_(b.date);
    case 'adminExport': return adminExport_(b.month);
  }
  throw new Error('ไม่รู้จักคำสั่ง');
}

function checkAdmin_(s, pw) {
  var real = String(s.ADMIN_PASSWORD || '').trim();
  if (!real) throw new Error('ยังไม่ได้ตั้งรหัสผ่านผู้ดูแล — ใส่ค่า ADMIN_PASSWORD ในชีต "ตั้งค่า"');
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('adminFails') || 0);
  if (fails >= 10) throw new Error('ใส่รหัสผ่านผิดหลายครั้ง ระบบล็อกชั่วคราว กรุณารอ 15 นาที');
  if (String(pw || '') !== real) {
    cache.put('adminFails', String(fails + 1), 900);
    throw new Error('รหัสผ่านไม่ถูกต้อง');
  }
  if (fails) cache.remove('adminFails');
}

function adminSettings_(s) {
  var o = {};
  SETTING_KEYS_EDITABLE.forEach(function (k) { o[k] = s[k] === undefined ? '' : String(s[k]); });
  return o;
}

function setSetting_(key, value) {
  var sh = ss_().getSheetByName(SHEET_SETTINGS);
  var keys = sh.getRange(1, 1, Math.max(1, sh.getLastRow()), 1).getValues();
  for (var i = 1; i < keys.length; i++) {
    if (String(keys[i][0]).trim() === key) {
      sh.getRange(i + 1, 2).setNumberFormat('@').setValue(String(value));
      return;
    }
  }
  var def = DEFAULT_SETTINGS.filter(function (d) { return d[0] === key; })[0];
  sh.appendRow([key, String(value), def ? def[2] : '']);
}

function adminSaveSettings_(v) {
  var num = function (k, min, max) {
    if (v[k] === undefined || v[k] === '') return;
    var n = Number(v[k]);
    if (!isFinite(n) || n < min || n > max) throw new Error('ค่า ' + k + ' ไม่ถูกต้อง (' + min + '–' + max + ')');
    setSetting_(k, n);
  };
  if (v.LAT !== undefined || v.LNG !== undefined) {
    var lat = Number(v.LAT), lng = Number(v.LNG);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
      throw new Error('พิกัดไม่ถูกต้อง');
    }
    setSetting_('LAT', lat.toFixed(6));
    setSetting_('LNG', lng.toFixed(6));
  }
  num('RADIUS_M', 20, 2000);
  num('LATE_GRACE_MIN', 0, 120);
  num('OPEN_BEFORE_MIN', 0, 480);
  num('MAX_ACCURACY_M', 0, 5000);
  ['SHIFT_M', 'SHIFT_A', 'SHIFT_N'].forEach(function (k) {
    if (v[k] === undefined) return;
    var t = String(v[k]).replace(/\s/g, '');
    if (!/^([01]\d|2[0-4]):[0-5]\d-([01]\d|2[0-4]):[0-5]\d$/.test(t)) throw new Error('เวลาเวรต้องเป็นรูปแบบ 08:00-16:00');
    setSetting_(k, t);
  });
  if (v.WARD_NAME !== undefined && String(v.WARD_NAME).trim()) setSetting_('WARD_NAME', String(v.WARD_NAME).trim().slice(0, 60));
  return { ok: true, message: 'บันทึกการตั้งค่าแล้ว', settings: adminSettings_(getSettings_()) };
}

/** เพิ่ม/แก้ไข/ลบ รายชื่อ: { origId, id, name, position, active, remove } */
function adminSaveStaff_(st) {
  var sh = ss_().getSheetByName(SHEET_STAFF);
  var id = String(st.id || '').trim(), name = String(st.name || '').trim();
  var origId = String(st.origId || '').trim();
  var last = Math.max(1, sh.getLastRow());
  var vals = sh.getRange(1, 1, last, 2).getValues();
  var rowOf = function (key) {
    for (var i = 1; i < vals.length; i++) if (key && String(vals[i][0]).trim() === key) return i + 1;
    return 0;
  };
  var row = rowOf(origId || id);
  if (st.remove) {
    if (!row) throw new Error('ไม่พบรายชื่อนี้');
    sh.getRange(row, 1, 1, 4).setValues([['', '', '', false]]);
    return { ok: true, message: 'ลบรายชื่อแล้ว', staff: getStaff_() };
  }
  if (!id || !name) throw new Error('กรุณาใส่รหัสพนักงานและชื่อ-สกุล');
  if (!/^[\w\-.]{1,20}$/.test(id)) throw new Error('รหัสพนักงานใช้ได้เฉพาะตัวเลข/ตัวอักษรอังกฤษ ไม่เกิน 20 ตัว');
  var dup = rowOf(id);
  if (dup && dup !== row) throw new Error('รหัสพนักงาน ' + id + ' มีอยู่แล้ว');
  if (!row) {
    for (var i = 1; i < vals.length; i++) {
      if (!String(vals[i][0]).trim() && !String(vals[i][1]).trim()) { row = i + 1; break; }
    }
    if (!row) row = last + 1;
  }
  sh.getRange(row, 1).setNumberFormat('@');
  sh.getRange(row, 1, 1, 4).setValues([[id, name.slice(0, 80), String(st.position || '').trim().slice(0, 60), st.active !== false]]);
  return { ok: true, message: 'บันทึกรายชื่อแล้ว', staff: getStaff_() };
}

function adminDay_(date) {
  date = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : bkkDateStr_(Date.now());
  var order = { 'ดึก': 0, 'เช้า': 1, 'บ่าย': 2 };
  var rows = readRecentLog_(3000).map(function (x) { return x.row; });
  var now = Date.now();
  var day = rows.filter(function (r) { return ds_(r[C.DATE]) === date; })
    .sort(function (a, b) { return (order[a[C.SHIFT]] - order[b[C.SHIFT]]) || (toMs_(a[C.IN]) - toMs_(b[C.IN])); })
    .map(recordToObj_);
  var onDuty = rows.filter(function (r) { return r[C.IN] && !r[C.OUT] && now - toMs_(r[C.IN]) < 20 * 3600000; })
    .map(recordToObj_);
  return { ok: true, date: date, dateTh: thaiDate_(date), records: day, onDuty: onDuty };
}

/** แถวบันทึกเวลาสำหรับส่งออก (ไม่รวมพิกัด/อุปกรณ์) asText = true คืนวันที่/เวลาเป็นข้อความ */
function exportLogRows_(logRows, asText) {
  var order = { 'ดึก': 0, 'เช้า': 1, 'บ่าย': 2 };
  var hm = function (v) { return v ? Utilities.formatDate(new Date(toMs_(v)), TZ, 'HH:mm') : ''; };
  return logRows.slice().sort(function (a, b) {
    return ds_(a[C.DATE]).localeCompare(ds_(b[C.DATE])) || (order[a[C.SHIFT]] - order[b[C.SHIFT]]) ||
      (toMs_(a[C.IN]) - toMs_(b[C.IN]));
  }).map(function (r) {
    var p = ds_(r[C.DATE]).split('-');
    var date = asText ? (p[2] + '/' + p[1] + '/' + p[0]) : new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 5));
    var tin = asText ? hm(r[C.IN]) : (r[C.IN] ? new Date(toMs_(r[C.IN])) : '');
    var tout = asText ? hm(r[C.OUT]) : (r[C.OUT] ? new Date(toMs_(r[C.OUT])) : '');
    return [date, r[C.SHIFT], String(r[C.STAFF_ID]), r[C.NAME], tin, r[C.IN_STATUS], Number(r[C.LATE_MIN]) || 0,
      tout, r[C.OUT_STATUS] || 'ไม่ได้ลงเวลาออก', Number(r[C.EARLY_MIN]) || 0,
      r[C.HOURS] === '' ? '' : Number(r[C.HOURS]), r[C.IN_DIST], r[C.OUT_DIST]];
  });
}

var EXPORT_LOG_HEADER = ['วันที่เวร', 'เวร', 'รหัสพนักงาน', 'ชื่อ-สกุล', 'เวลาเข้า', 'สถานะเข้า', 'นาทีสาย',
  'เวลาออก', 'สถานะออก', 'นาทีออกก่อน', 'ชั่วโมงทำงาน', 'ระยะห่างตอนเข้า (ม.)', 'ระยะห่างตอนออก (ม.)'];

function adminExport_(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw new Error('กรุณาเลือกเดือน');
  var m = computeMonthly_(month);
  return {
    ok: true, month: month, monthTh: thaiMonth_(month), title: m.title,
    summaryHeader: m.header, summary: m.summary,
    logHeader: EXPORT_LOG_HEADER, logs: exportLogRows_(m.logRows, true),
    created: Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy HH:mm')
  };
}

/* ============================== ตรรกะเวร ============================== */

function getShifts_(s) {
  return SHIFT_DEFS.map(function (d) {
    var parts = String(s[d.key] || '').split('-');
    return { code: d.code, name: d.name, start: parts[0].trim(), end: (parts[1] || '').trim() };
  });
}

function hmToMin_(hm) {
  var p = String(hm).split(':');
  return Number(p[0]) * 60 + Number(p[1] || 0);
}

/** คืนค่าเวลาเริ่ม/สิ้นสุดเวร (ms) ของวันที่เวร yyyy-MM-dd (เวลาไทย) */
function shiftBoundsForDate_(shift, dateStr) {
  var p = dateStr.split('-');
  var dayStart = Date.UTC(+p[0], +p[1] - 1, +p[2]) - TZ_OFFSET_MS;
  var startMin = hmToMin_(shift.start);
  var endMin = hmToMin_(shift.end);
  if (endMin <= startMin) endMin += 1440;
  return { start: dayStart + startMin * 60000, end: dayStart + endMin * 60000 };
}

/** หาวันที่เวรที่ "ตอนนี้" อยู่ในช่วง [เริ่ม - openBefore, สิ้นสุด) */
function findShiftWindow_(shift, now, openBeforeMin) {
  for (var off = -1; off <= 1; off++) {
    var dateStr = bkkDateStr_(now + off * 86400000);
    var b = shiftBoundsForDate_(shift, dateStr);
    if (now >= b.start - openBeforeMin * 60000 && now < b.end) {
      return { date: dateStr, start: b.start, end: b.end };
    }
  }
  return null;
}

function bkkDateStr_(ms) {
  var d = new Date(ms + TZ_OFFSET_MS);
  return d.getUTCFullYear() + '-' + pad_(d.getUTCMonth() + 1) + '-' + pad_(d.getUTCDate());
}

function pad_(n) { return (n < 10 ? '0' : '') + n; }

function thaiDate_(dateStr) {
  var p = String(dateStr).split('-');
  return Number(p[2]) + '/' + Number(p[1]) + '/' + (Number(p[0]) + 543);
}

/* ============================== GPS ============================== */

function checkGeo_(s, b) {
  if (s.LAT === '' || s.LNG === '') {
    throw new Error('ผู้ดูแลยังไม่ได้ตั้งค่าพิกัดหอผู้ป่วยในชีต "ตั้งค่า"');
  }
  var lat = Number(b.lat), lng = Number(b.lng), acc = Number(b.accuracy) || 0;
  if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) {
    throw new Error('ไม่ได้รับพิกัด GPS กรุณาเปิดตำแหน่งที่ตั้งแล้วลองใหม่');
  }
  var maxAcc = Number(s.MAX_ACCURACY_M) || 0;
  if (maxAcc > 0 && acc > maxAcc) {
    throw new Error('สัญญาณ GPS คลาดเคลื่อนมาก (±' + Math.round(acc) + ' ม.) กรุณาลองใหม่');
  }
  var dist = Math.round(haversine_(lat, lng, Number(s.LAT), Number(s.LNG)));
  var radius = Number(s.RADIUS_M) || 100;
  if (dist > radius) {
    throw new Error('อยู่นอกพื้นที่หอผู้ป่วย (ห่าง ' + dist + ' ม. อนุญาตไม่เกิน ' + radius + ' ม.)');
  }
  return { distance: dist, text: lat.toFixed(6) + ',' + lng.toFixed(6) + ' ±' + Math.round(acc) + 'ม.' };
}

function haversine_(lat1, lon1, lat2, lon2) {
  var R = 6371000, toRad = Math.PI / 180;
  var dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* ============================== ชีต ============================== */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function logSheet_() {
  var sh = ss_().getSheetByName(SHEET_LOG);
  if (!sh) throw new Error('ไม่พบชีต "' + SHEET_LOG + '" กรุณารันฟังก์ชัน setup');
  return sh;
}

function getSettings_() {
  var sh = ss_().getSheetByName(SHEET_SETTINGS);
  if (!sh) throw new Error('ไม่พบชีต "' + SHEET_SETTINGS + '" กรุณารันฟังก์ชัน setup');
  var vals = sh.getDataRange().getValues();
  var s = {};
  DEFAULT_SETTINGS.forEach(function (d) { s[d[0]] = d[1]; });
  vals.slice(1).forEach(function (r) {
    if (r[0]) s[String(r[0]).trim()] = (r[1] instanceof Date) ? Utilities.formatDate(r[1], TZ, 'HH:mm') : r[1];
  });
  return s;
}

function getStaff_() {
  var sh = ss_().getSheetByName(SHEET_STAFF);
  if (!sh) return [];
  return sh.getDataRange().getValues().slice(1)
    .filter(function (r) { return String(r[0]).trim() && String(r[1]).trim(); })
    .map(function (r) {
      return {
        id: String(r[0]).trim(), name: String(r[1]).trim(), position: String(r[2] || '').trim(),
        active: !(r[3] === false || String(r[3]).toUpperCase() === 'FALSE' || r[3] === 'ไม่ใช้งาน')
      };
    });
}

function findStaff_(id) {
  id = String(id || '').trim();
  var st = getStaff_().filter(function (x) { return x.id === id && x.active; })[0];
  if (!st) throw new Error('ไม่พบรายชื่อนี้ในระบบ หรือถูกปิดการใช้งาน');
  return st;
}

/** อ่านแถวล่าสุด n แถวของชีตบันทึกเวลา คืนค่า [{rowNum, row}] */
function readRecentLog_(n) {
  var sh = logSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var first = Math.max(2, last - n + 1);
  var vals = sh.getRange(first, 1, last - first + 1, LOG_HEADERS.length).getValues();
  return vals.map(function (row, i) { return { rowNum: first + i, row: row }; });
}

/** วันที่เวรอาจถูกชีตแปลงเป็น Date ให้แปลงกลับเป็น yyyy-MM-dd */
function ds_(v) {
  return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v);
}

function toMs_(v) { return v instanceof Date ? v.getTime() : new Date(v).getTime(); }

function recordToObj_(r) {
  var fmt = function (v) { return v ? Utilities.formatDate(new Date(toMs_(v)), TZ, 'HH:mm') : ''; };
  return {
    id: r[C.ID], staffId: String(r[C.STAFF_ID]), name: r[C.NAME], date: ds_(r[C.DATE]), dateTh: thaiDate_(ds_(r[C.DATE])), shift: r[C.SHIFT],
    inTime: fmt(r[C.IN]), inStatus: r[C.IN_STATUS], inDist: r[C.IN_DIST],
    outTime: fmt(r[C.OUT]), outStatus: r[C.OUT_STATUS], hours: r[C.HOURS]
  };
}

/* ============================== ติดตั้ง / เมนู ============================== */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('MICU 2 เวลาเข้า-ออกงาน')
    .addItem('สรุปรายเดือน…', 'menuMonthlySummary')
    .addItem('รายงานรายวัน…', 'menuDailyReport')
    .addItem('📥 ส่งออก Excel รายเดือน…', 'menuExportExcel')
    .addSeparator()
    .addItem('ติดตั้ง/ซ่อมแซมชีต (setup)', 'setup')
    .addToUi();
}

function setup() {
  var ss = ss_();
  ss.setSpreadsheetTimeZone(TZ);

  var st = ss.getSheetByName(SHEET_SETTINGS) || ss.insertSheet(SHEET_SETTINGS);
  if (st.getLastRow() < 2) {
    st.getRange('B:B').setNumberFormat('@');
    st.getRange(1, 1, 1, 3).setValues([['คีย์', 'ค่า', 'คำอธิบาย']]);
    st.getRange(2, 1, DEFAULT_SETTINGS.length, 3).setValues(DEFAULT_SETTINGS);
  } else {
    var keys = st.getRange(2, 1, st.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; });
    DEFAULT_SETTINGS.forEach(function (d) { if (keys.indexOf(d[0]) < 0) st.appendRow(d); });
  }
  st.getRange('B:B').setNumberFormat('@');
  styleHeader_(st, 3);
  st.setColumnWidth(1, 160); st.setColumnWidth(2, 160); st.setColumnWidth(3, 460);

  var sf = ss.getSheetByName(SHEET_STAFF) || ss.insertSheet(SHEET_STAFF);
  if (sf.getLastRow() < 1) {
    sf.getRange(1, 1, 1, 4).setValues([['รหัสพนักงาน', 'ชื่อ-สกุล', 'ตำแหน่ง', 'ใช้งาน']]);
    sf.getRange('A:A').setNumberFormat('@');
    sf.getRange(2, 1, 2, 4).setValues([
      ['0001', 'ตัวอย่าง พยาบาลหนึ่ง', 'พยาบาลวิชาชีพ', true],
      ['0002', 'ตัวอย่าง พยาบาลสอง', 'พยาบาลวิชาชีพ', true]
    ]);
    sf.getRange('D2:D300').insertCheckboxes();
  }
  styleHeader_(sf, 4);
  sf.setColumnWidth(2, 220);

  var lg = ss.getSheetByName(SHEET_LOG) || ss.insertSheet(SHEET_LOG);
  if (lg.getLastRow() < 1) {
    lg.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]);
  }
  lg.getRange('B:B').setNumberFormat('@');
  lg.getRange('D:D').setNumberFormat('@');
  lg.getRange('F:F').setNumberFormat('dd/MM/yyyy HH:mm');
  lg.getRange('K:K').setNumberFormat('dd/MM/yyyy HH:mm');
  styleHeader_(lg, LOG_HEADERS.length);

  var def = ss.getSheetByName('Sheet1') || ss.getSheetByName('ชีต1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);

  try {
    SpreadsheetApp.getUi().alert('ติดตั้งเรียบร้อย\n\n1) ใส่รายชื่อพยาบาลในชีต "' + SHEET_STAFF +
      '"\n2) ใส่พิกัด LAT/LNG ในชีต "' + SHEET_SETTINGS + '"\n3) Deploy เป็นเว็บแอป');
  } catch (e) { /* รันจาก editor */ }
}

function styleHeader_(sh, cols) {
  sh.getRange(1, 1, 1, cols).setFontWeight('bold').setBackground('#0f6e6e').setFontColor('#ffffff');
  sh.setFrozenRows(1);
}

/* ============================== รายงาน ============================== */

function menuMonthlySummary() {
  var month = askMonth_('สรุปรายเดือน');
  if (month) buildMonthlySummary(month);
}

/** ถามเดือน รับได้ทั้ง 2026-11, 11/2569, 11/2026 (ค.ศ. หรือ พ.ศ.) คืนค่า yyyy-MM หรือ null */
function askMonth_(title) {
  var ui = SpreadsheetApp.getUi();
  var cur = bkkDateStr_(Date.now()).slice(0, 7);
  var curTh = Number(cur.slice(5)) + '/' + (Number(cur.slice(0, 4)) + 543);
  var res = ui.prompt(title, 'ระบุเดือน/ปี เช่น ' + curTh + ' (พ.ศ.) หรือ ' + cur +
    '\nเว้นว่างไว้ = เดือนปัจจุบัน', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return null;
  var t = res.getResponseText().trim();
  if (!t) return cur;
  var m = t.match(/^(\d{4})[-\/.](\d{1,2})$/), y, mo;
  if (m) { y = +m[1]; mo = +m[2]; }
  else if ((m = t.match(/^(\d{1,2})[-\/.](\d{4})$/))) { y = +m[2]; mo = +m[1]; }
  else { ui.alert('รูปแบบเดือนไม่ถูกต้อง ตัวอย่าง: ' + curTh); return null; }
  if (y > 2400) y -= 543;
  if (mo < 1 || mo > 12) { ui.alert('เดือนต้องอยู่ระหว่าง 1–12'); return null; }
  return y + '-' + pad_(mo);
}

function thaiMonth_(month) {
  var names = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  return names[Number(month.slice(5)) - 1] + ' ' + (Number(month.slice(0, 4)) + 543);
}

/** สร้างชีต "สรุป yyyy-MM": จำนวนเวร มาสาย ออกก่อน ไม่ลงเวลาออก ชั่วโมงรวม ต่อคน */
function buildMonthlySummary(month) {
  var m = computeMonthly_(month);
  writeReport_('สรุป ' + month, m.title, m.header, m.summary, [1]);
}

/** คำนวณสรุปรายเดือน คืนค่า { title, header, summary, logRows } */
function computeMonthly_(month) {
  var s = getSettings_();
  var shifts = getShifts_(s);
  var rows = readRecentLog_(100000).map(function (x) { return x.row; })
    .filter(function (r) { return ds_(r[C.DATE]).slice(0, 7) === month; });
  var now = Date.now();
  var by = {};
  getStaff_().forEach(function (st) { by[st.id] = blankSum_(st.id, st.name); });
  rows.forEach(function (r) {
    var id = String(r[C.STAFF_ID]);
    var o = by[id] || (by[id] = blankSum_(id, r[C.NAME]));
    o[r[C.SHIFT]] = (o[r[C.SHIFT]] || 0) + 1;
    o.total++;
    if (Number(r[C.LATE_MIN]) > 0) { o.late++; o.lateMin += Number(r[C.LATE_MIN]); }
    if (Number(r[C.EARLY_MIN]) > 0) { o.early++; o.earlyMin += Number(r[C.EARLY_MIN]); }
    if (!r[C.OUT]) {
      var sh = shifts.filter(function (x) { return x.name === r[C.SHIFT]; })[0];
      if (sh && now > shiftBoundsForDate_(sh, ds_(r[C.DATE])).end + 4 * 3600000) o.noOut++;
    }
    o.hours += Number(r[C.HOURS]) || 0;
  });

  var header = ['รหัส', 'ชื่อ-สกุล', 'เวรเช้า', 'เวรบ่าย', 'เวรดึก', 'รวมเวร',
    'มาสาย (ครั้ง)', 'มาสายรวม (นาที)', 'ออกก่อน (ครั้ง)', 'ออกก่อนรวม (นาที)', 'ไม่ลงเวลาออก (ครั้ง)', 'ชั่วโมงรวม'];
  var out = Object.keys(by).map(function (k) {
    var o = by[k];
    return [o.id, o.name, o['เช้า'] || 0, o['บ่าย'] || 0, o['ดึก'] || 0, o.total,
      o.late, o.lateMin, o.early, o.earlyMin, o.noOut, Math.round(o.hours * 100) / 100];
  });
  return {
    title: 'สรุปการลงเวลา ' + (s.WARD_NAME || '') + ' เดือน' + thaiMonth_(month),
    header: header, summary: out, logRows: rows
  };
}

/* ============================== ส่งออก Excel ============================== */

function menuExportExcel() {
  var month = askMonth_('ส่งออก Excel รายเดือน');
  if (month) exportMonthlyExcel(month);
}

/**
 * สร้างไฟล์ Google Sheet แยก (ชีต "สรุปรายเดือน" + "บันทึกเวลา") แล้วแสดงปุ่มดาวน์โหลดเป็น .xlsx
 * ไม่รวมพิกัดและข้อมูลอุปกรณ์ เพื่อลดการเปิดเผยข้อมูลส่วนบุคคล
 */
function exportMonthlyExcel(month) {
  var m = computeMonthly_(month);
  var logs = exportLogRows_(m.logRows, false);
  var logHeader = EXPORT_LOG_HEADER;

  var name = 'MICU 2 เวลาเข้า-ออกงาน ' + month;
  var out = SpreadsheetApp.create(name);
  out.setSpreadsheetTimeZone(TZ);
  var sum = out.getSheets()[0];
  sum.setName('สรุปรายเดือน');
  writeTable_(sum, m.title, m.header, m.summary, [1]);
  var lg = out.insertSheet('บันทึกเวลา');
  writeTable_(lg, 'บันทึกเวลารายเวร เดือน' + thaiMonth_(month) + ' (' + logs.length + ' รายการ)', logHeader, logs, [3]);
  if (logs.length) {
    lg.getRange(4, 1, logs.length, 1).setNumberFormat('dd/mm/yyyy');
    lg.getRange(4, 5, logs.length, 1).setNumberFormat('hh:mm');
    lg.getRange(4, 8, logs.length, 1).setNumberFormat('hh:mm');
    lg.autoResizeColumns(1, logHeader.length);
  }
  SpreadsheetApp.flush();

  var xlsx = 'https://docs.google.com/spreadsheets/d/' + out.getId() + '/export?format=xlsx';
  var html = HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;text-align:center;padding:8px">' +
    '<div style="font-size:15px;margin-bottom:6px">สร้างไฟล์เดือน<b>' + thaiMonth_(month) + '</b> เรียบร้อย</div>' +
    '<div style="color:#64748b;font-size:13px;margin-bottom:16px">สรุป ' + m.summary.length + ' คน · บันทึก ' + logs.length + ' รายการ</div>' +
    '<a href="' + xlsx + '" target="_blank" style="display:block;background:#0d9488;color:#fff;text-decoration:none;' +
    'padding:14px;border-radius:10px;font-size:16px;font-weight:bold">📥 ดาวน์โหลดไฟล์ Excel</a>' +
    '<a href="' + out.getUrl() + '" target="_blank" style="display:block;margin-top:12px;color:#2563eb;font-size:13px">' +
    'หรือเปิดดูใน Google Sheets</a>' +
    '<div style="color:#94a3b8;font-size:12px;margin-top:14px">สำเนาเก็บไว้ใน Google Drive ชื่อ "' + name + '"</div></div>'
  ).setWidth(380).setHeight(270);
  SpreadsheetApp.getUi().showModalDialog(html, 'ส่งออก Excel');
}

function blankSum_(id, name) {
  return { id: id, name: name, total: 0, late: 0, lateMin: 0, early: 0, earlyMin: 0, noOut: 0, hours: 0 };
}

function menuDailyReport() {
  var ui = SpreadsheetApp.getUi();
  var def = bkkDateStr_(Date.now());
  var res = ui.prompt('รายงานรายวัน', 'ระบุวันที่เวร (ค.ศ.) รูปแบบ yyyy-MM-dd เช่น ' + def, ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var date = res.getResponseText().trim() || def;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { ui.alert('รูปแบบวันที่ไม่ถูกต้อง'); return; }
  buildDailyReport(date);
}

function buildDailyReport(date) {
  var order = { 'ดึก': 0, 'เช้า': 1, 'บ่าย': 2 };
  var fmt = function (v) { return v ? Utilities.formatDate(new Date(toMs_(v)), TZ, 'HH:mm') : '-'; };
  var rows = readRecentLog_(100000).map(function (x) { return x.row; })
    .filter(function (r) { return ds_(r[C.DATE]) === date; })
    .sort(function (a, b) { return (order[a[C.SHIFT]] - order[b[C.SHIFT]]) || (toMs_(a[C.IN]) - toMs_(b[C.IN])); })
    .map(function (r) {
      return [r[C.SHIFT], r[C.STAFF_ID], r[C.NAME], fmt(r[C.IN]), r[C.IN_STATUS],
        fmt(r[C.OUT]), r[C.OUT_STATUS] || 'ยังไม่ลงเวลาออก', r[C.HOURS]];
    });
  var header = ['เวร', 'รหัส', 'ชื่อ-สกุล', 'เวลาเข้า', 'สถานะเข้า', 'เวลาออก', 'สถานะออก', 'ชั่วโมง'];
  writeReport_('รายวัน ' + date, 'รายงานการลงเวลาวันที่ ' + thaiDate_(date), header, rows);
}

function writeReport_(name, title, header, rows, textCols) {
  var ss = ss_();
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  writeTable_(sh, title, header, rows, textCols);
  ss.setActiveSheet(sh);
}

/** textCols = หมายเลขคอลัมน์ (เริ่ม 1) ที่ต้องเก็บเป็นข้อความ เช่น รหัส 0001 */
function writeTable_(sh, title, header, rows, textCols) {
  sh.clear();
  sh.getRange(1, 1).setValue(title).setFontWeight('bold').setFontSize(13);
  sh.getRange(2, 1).setValue('สร้างเมื่อ ' + Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy HH:mm'));
  sh.getRange(3, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#0f6e6e').setFontColor('#ffffff');
  (textCols || []).forEach(function (c) { if (rows.length) sh.getRange(4, c, rows.length, 1).setNumberFormat('@'); });
  if (rows.length) sh.getRange(4, 1, rows.length, header.length).setValues(rows);
  else sh.getRange(4, 1).setValue('ไม่มีข้อมูล');
  sh.setFrozenRows(3);
  sh.autoResizeColumns(1, header.length);
}
