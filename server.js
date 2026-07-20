// Локальный сервер: раздаёт фронтенд диаграммы Ганта и проксирует запросы к Jira Cloud.
// Запуск: npm install && npm start, затем открыть http://localhost:3210

const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ProxyAgent, setGlobalDispatcher } = require('undici');

const app = express();
const PORT = process.env.PORT || 3210;

// ---- Корпоративный прокси: если ноутбук ходит в интернет только через прокси,
// сервер сам через него сходит в Jira. Укажите адрес прокси в переменной окружения
// HTTPS_PROXY (или HTTP_PROXY) перед запуском — см. start.bat/README.
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (PROXY_URL) {
  try {
    setGlobalDispatcher(new ProxyAgent(PROXY_URL));
    console.log('  Использую прокси для запросов к Jira: ' + PROXY_URL);
  } catch (e) {
    console.error('  Не удалось настроить прокси ' + PROXY_URL + ': ' + e.message);
  }
}

// Внутри exe, собранного через pkg, __dirname указывает на виртуальный снапшот
// (только для чтения) — файлы, в которые нужно писать, кладём рядом с самим
// исполняемым файлом (process.execPath), а не внутрь снапшота.
const WRITABLE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;

// ---- «Запомнить на этом устройстве»: локальный файл рядом с сервером, в .gitignore ----
// Несколько человек могут одновременно работать с одним и тем же запущенным сервером
// (например, зайдя на него по локальной сети с разных компьютеров), поэтому «запомненные»
// данные входа хранятся не одним объектом, а по устройствам — ключ - случайный id в
// отдельной httpOnly-куке браузера (deviceId), не связанной с сессией. Так вход одного
// человека с галочкой «запомнить» не перезаписывает и не подменяет вход другого.
const CONFIG_PATH = path.join(WRITABLE_DIR, '.jira-config.json');
const DEVICE_COOKIE = 'deviceId';
const DEVICE_COOKIE_MAX_AGE_SEC = 400 * 24 * 60 * 60; // ~400 дней (максимум, который принимают браузеры)

function loadDevices() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return (data && typeof data.devices === 'object' && data.devices) ? data.devices : {};
  } catch (e) { return {}; }
}
function saveDevices(devices) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ devices }, null, 2), { encoding: 'utf8', mode: 0o600 });
}
function getDeviceId(req) {
  const raw = req.headers.cookie || '';
  const found = raw.split(';').map(s => s.trim()).find(s => s.startsWith(DEVICE_COOKIE + '='));
  return found ? decodeURIComponent(found.slice(DEVICE_COOKIE.length + 1)) : null;
}
function setDeviceCookie(res, id) {
  res.append('Set-Cookie', DEVICE_COOKIE + '=' + encodeURIComponent(id) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + DEVICE_COOKIE_MAX_AGE_SEC);
}
function clearDeviceCookie(res) {
  res.append('Set-Cookie', DEVICE_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
function loadSavedConfigForDevice(deviceId) {
  if (!deviceId) return null;
  const devices = loadDevices();
  return devices[deviceId] || null;
}
function saveConfigForDevice(deviceId, cfg) {
  const devices = loadDevices();
  devices[deviceId] = cfg;
  saveDevices(devices);
}
function clearConfigForDevice(deviceId) {
  if (!deviceId) return;
  const devices = loadDevices();
  if (devices[deviceId]) {
    delete devices[deviceId];
    saveDevices(devices);
  }
}
function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

// ---- Настройки полей Jira (специфичны для конкретного проекта/инстанса) ----
// Если диаграмма строится для другого проекта Jira, замените ID полей ниже
// (их можно найти через Jira -> Настройки -> Поля, либо через /rest/api/3/field).
const FIELD_START = 'customfield_10248';       // Дата начала
const FIELD_PLAN_END = 'customfield_10311';    // Плановая дата завершения
const FIELD_RESCHEDULE = 'customfield_10537';  // Количество переносов плановой даты

const SYSTEM_MAP = { EWM: 'EWM', OPER: 'ERP', TEST: 'TEST', ABAP: 'ABAP', BASIS: 'BASIS' };
function systemOf(key) {
  const prefix = key.split('-')[0];
  return SYSTEM_MAP[prefix] || prefix;
}
const RANK_ORDER = { 'Блокирует Бизнес': 0, 'Критический': 1, 'Важная': 2, 'Normal': 3, 'Незначительный': 4 };

// Ищет среди issuelinks задачи ключ первой связанной задачи проекта ABAP (любой тип связи, любое направление)
// (логика перенесена из jira-roadmap-app)
function findLinkedAbapKey(issue) {
  const links = (issue.fields && issue.fields.issuelinks) || [];
  for (const link of links) {
    const other = link.outwardIssue || link.inwardIssue;
    if (other && /^ABAP-/.test(other.key)) return other.key;
  }
  return null;
}

app.use(express.json());
app.use(session({
  secret: crypto.randomBytes(32).toString('hex'), // новый секрет при каждом запуске сервера
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 } // 8 часов
}));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Вспомогательная функция обращения к Jira REST API ----
function normalizeSite(site) {
  site = site.trim().replace(/\/$/, '');
  if (!site.startsWith('http')) site = 'https://' + site;
  return site;
}

async function jiraFetch(req, apiPath, options = {}) {
  const cred = req.session.jira;
  if (!cred) {
    const err = new Error('Не авторизовано');
    err.status = 401;
    throw err;
  }
  const url = cred.site + apiPath;
  const auth = Buffer.from(cred.email + ':' + cred.apiToken).toString('base64');
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': 'Basic ' + auth,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  return res;
}

// ---- Понятное сообщение вместо технического "fetch failed" ----
const tls = require('tls');

// Подключается напрямую (без проверки сертификата) и выясняет, какую цепочку
// сертификатов реально видит сам Node.js — это может отличаться от того, что
// показывает браузер, если защитное ПО перехватывает трафik разных программ
// по-разному.
function dumpCertChain(hostname, port) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    try {
      const socket = tls.connect({ host: hostname, port: port || 443, servername: hostname, rejectUnauthorized: false }, () => {
        const chain = [];
        let cert = socket.getPeerCertificate(true);
        const seen = new Set();
        while (cert && cert.subject && !seen.has(cert.fingerprint)) {
          seen.add(cert.fingerprint);
          chain.push({
            subject: (cert.subject && (cert.subject.CN || cert.subject.O)) || '?',
            issuer: (cert.issuer && (cert.issuer.CN || cert.issuer.O)) || '?'
          });
          cert = (cert.issuerCertificate && cert.issuerCertificate.fingerprint !== cert.fingerprint) ? cert.issuerCertificate : null;
        }
        socket.end();
        if (chain.length === 0) {
          const reason = 'TLS-соединение установлено, но цепочка сертификатов пуста (getPeerCertificate вернул пусто)';
          console.error('  [диагностика сертификата] ' + reason);
          finish({ chain: null, reason });
        } else {
          finish({ chain, reason: null });
        }
      });
      socket.on('error', (err) => {
        const reason = 'не удалось напрямую подключиться к ' + hostname + ':' + (port || 443) + ' (' + err.message + ')';
        console.error('  [диагностика сертификата] ' + reason);
        finish({ chain: null, reason });
      });
      socket.setTimeout(4000, () => {
        const reason = 'таймаут прямого подключения к ' + hostname + ':' + (port || 443) + ' (4 секунды)';
        console.error('  [диагностика сертификата] ' + reason);
        socket.destroy();
        finish({ chain: null, reason });
      });
    } catch (e) {
      const reason = 'исключение — ' + e.message;
      console.error('  [диагностика сертификата] ' + reason);
      finish({ chain: null, reason });
    }
  });
}

async function friendlyNetworkError(e, hostname) {
  const code = e && e.cause && e.cause.code;
  if (e.message === 'fetch failed' || code) {
    let hint = 'Не удалось подключиться к Jira по сети.';
    const certCodes = ['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED'];
    if (certCodes.includes(code)) {
      hint += ' Похоже, корпоративная защита (антивирус/фаервол) подменяет сертификаты сайтов своим — браузер ему доверяет, а Node.js по умолчанию нет.';
      let chainFound = false;
      let diagReason = null;
      if (hostname) {
        const diag = await dumpCertChain(hostname);
        if (diag && diag.chain && diag.chain.length) {
          chainFound = true;
          const top = diag.chain[diag.chain.length - 1];
          hint += ' Реальная цепочка сертификатов, которую видит само приложение: '
            + diag.chain.map(c => c.subject).join(' → ') + '.'
            + ' Скорее всего, вам нужен корневой сертификат «' + top.subject + '» (обычно его можно найти в Windows: certmgr.msc → Доверенные корневые центры сертификации → экспортировать этот же сертификат по имени).';
        } else if (diag) {
          diagReason = diag.reason;
        }
      }
      if (!chainFound) {
        hint += ' Автоматическая диагностика не дала ответа'
          + (diagReason ? (' (причина: ' + diagReason + ')') : '') + '.'
          + ' Ручной способ: в Windows откройте certmgr.msc → «Доверенные корневые центры сертификации» → найдите сертификат с именем вашей компании/антивируса (НЕ Amazon/DigiCert/Let\'s Encrypt) → правой кнопкой «Все задачи» → «Экспорт» → формат Base-64 X.509 (.CER).';
      }
      hint += ' Путь к экспортированному файлу укажите в переменной окружения NODE_EXTRA_CA_CERTS (см. README, раздел «Корпоративный прокси / сертификат»).';
    } else if (code === 'ENOTFOUND') {
      hint += ' Проверьте правильность адреса сайта Jira (например detmir.atlassian.net).';
    } else if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
      hint += ' Похоже, соединение блокируется — часто это корпоративный прокси. Укажите его адрес в переменной окружения HTTPS_PROXY (см. README).';
    } else {
      hint += ' Часто причина — корпоративный прокси-сервер или подмена сертификатов защитным ПО компании. Подробности — в README, раздел «Корпоративный прокси».';
    }
    return hint;
  }
  return 'Внутренняя ошибка: ' + e.message;
}

// ---- Авторизация ----
app.post('/api/login', async (req, res) => {
  try {
    const { site, email, apiToken, remember } = req.body;
    if (!site || !email || !apiToken) {
      return res.status(400).json({ error: 'Укажите адрес Jira, email и API-токен.' });
    }
    const normalizedSite = normalizeSite(site);
    const auth = Buffer.from(email + ':' + apiToken).toString('base64');
    const meRes = await fetch(normalizedSite + '/rest/api/3/myself', {
      headers: { 'Authorization': 'Basic ' + auth, 'Accept': 'application/json' }
    });
    if (meRes.status === 401 || meRes.status === 403) {
      return res.status(401).json({ error: 'Jira отклонила email/токен. Проверьте данные и права доступа.' });
    }
    if (!meRes.ok) {
      return res.status(502).json({ error: 'Не удалось связаться с Jira (' + meRes.status + '). Проверьте адрес сайта.' });
    }
    const me = await meRes.json();
    req.session.jira = { site: normalizedSite, email, apiToken };
    req.session.user = { displayName: me.displayName, avatarUrl: me.avatarUrls && me.avatarUrls['32x32'] };

    let deviceId = getDeviceId(req);
    if (remember) {
      if (!deviceId) { deviceId = crypto.randomUUID(); setDeviceCookie(res, deviceId); }
      saveConfigForDevice(deviceId, { site: normalizedSite, email, apiToken, displayName: me.displayName, avatarUrl: req.session.user.avatarUrl });
    } else if (deviceId) {
      clearConfigForDevice(deviceId);
    }
    res.json({ ok: true, user: req.session.user, site: normalizedSite });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: await friendlyNetworkError(e, (function(){try{return new URL(normalizedSite).hostname;}catch(_){return null;}})()) });
  }
});

app.post('/api/logout', (req, res) => {
  clearConfigForDevice(getDeviceId(req));
  clearDeviceCookie(res);
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', async (req, res) => {
  if (req.session.jira && req.session.user) {
    return res.json({ loggedIn: true, user: req.session.user, site: req.session.jira.site });
  }
  // Сессия истекла/сервер перезапущен — пробуем восстановить данные, запомненные
  // именно для этого браузера/устройства (см. DEVICE_COOKIE выше)
  const saved = loadSavedConfigForDevice(getDeviceId(req));
  if (saved && saved.site && saved.email && saved.apiToken) {
    try {
      const auth = Buffer.from(saved.email + ':' + saved.apiToken).toString('base64');
      const meRes = await fetch(saved.site + '/rest/api/3/myself', {
        headers: { 'Authorization': 'Basic ' + auth, 'Accept': 'application/json' }
      });
      if (meRes.ok) {
        const me = await meRes.json();
        req.session.jira = { site: saved.site, email: saved.email, apiToken: saved.apiToken };
        req.session.user = { displayName: me.displayName, avatarUrl: me.avatarUrls && me.avatarUrls['32x32'] };
        return res.json({ loggedIn: true, user: req.session.user, site: saved.site, restored: true });
      }
    } catch (e) { /* сохранённые данные недействительны — падаем в обычный логин ниже */ }
    clearConfigForDevice(getDeviceId(req));
  }
  res.json({ loggedIn: false });
});

// ---- Список фильтров пользователя (избранные + поиск по имени) ----
app.get('/api/filters', async (req, res) => {
  try {
    const q = req.query.q || '';
    let results = [];
    const favRes = await jiraFetch(req, '/rest/api/3/filter/favourite');
    if (favRes.ok) {
      const favs = await favRes.json();
      results = favs.map(f => ({ id: f.id, name: f.name, favourite: true }));
    }
    if (q) {
      const searchRes = await jiraFetch(req, '/rest/api/3/filter/search?filterName=' + encodeURIComponent(q) + '&maxResults=20');
      if (searchRes.ok) {
        const data = await searchRes.json();
        const extra = (data.values || []).map(f => ({ id: f.id, name: f.name, favourite: false }));
        const knownIds = new Set(results.map(r => r.id));
        extra.forEach(f => { if (!knownIds.has(f.id)) results.push(f); });
      }
    }
    res.json({ filters: results });
  } catch (e) {
    res.status(e.status || 500).json({ error: await friendlyNetworkError(e, (function(){try{return new URL(req.session.jira.site).hostname;}catch(_){return null;}})()) });
  }
});

// ---- Загрузка задач по фильтру (id фильтра или произвольный JQL) ----
app.get('/api/issues', async (req, res) => {
  try {
    const { filterId, jql: rawJql } = req.query;
    let jql;
    if (rawJql) jql = rawJql;
    else if (filterId) jql = 'filter = ' + filterId;
    else return res.status(400).json({ error: 'Укажите filterId или jql' });

    const fields = [
      'summary', 'status', 'assignee', 'priority', 'issuetype', 'labels',
      'created', 'updated', 'timeoriginalestimate', 'timespent', 'timeestimate',
      FIELD_START, FIELD_PLAN_END, FIELD_RESCHEDULE, 'duedate', 'issuelinks'
    ];

    let allIssues = [];
    let nextPageToken = null;
    let guard = 0;
    do {
      guard++;
      const body = {
        jql,
        fields,
        maxResults: 100,
        ...(nextPageToken ? { nextPageToken } : {})
      };
      const searchRes = await jiraFetch(req, '/rest/api/3/search/jql', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (!searchRes.ok) {
        const errText = await searchRes.text();
        return res.status(searchRes.status).json({ error: 'Jira вернула ошибку: ' + errText.slice(0, 300) });
      }
      const data = await searchRes.json();
      allIssues = allIssues.concat(data.issues || []);
      nextPageToken = data.isLast ? null : data.nextPageToken;
    } while (nextPageToken && guard < 30);

    // Для задач со связанной ABAP-задачей подтягиваем её реальные данные (оценка/статус/исполнитель)
    // одним пакетным запросом (логика перенесена из jira-roadmap-app)
    const abapKeys = [...new Set(allIssues.map(findLinkedAbapKey).filter(Boolean))];
    const abapByKey = {};
    for (let i = 0; i < abapKeys.length; i += 50) {
      const chunk = abapKeys.slice(i, i + 50);
      const abapJql = 'key in (' + chunk.join(',') + ')';
      const abapRes = await jiraFetch(req, '/rest/api/3/search/jql', {
        method: 'POST',
        body: JSON.stringify({ jql: abapJql, maxResults: 100, fields: ['summary', 'assignee', 'status', 'timeoriginalestimate', 'timespent', 'timeestimate'] })
      });
      if (abapRes.ok) {
        const abapData = await abapRes.json();
        (abapData.issues || []).forEach(ai => { abapByKey[ai.key] = ai; });
      }
    }

    const tasks = [];
    const backlog = [];
    allIssues.forEach(issue => {
      const f = issue.fields;
      const priority = (f.priority && f.priority.name) || 'Normal';
      const item = {
        key: issue.key,
        sum: f.summary || '',
        status: (f.status && f.status.name) || 'Новый',
        assignee: (f.assignee && f.assignee.displayName) || '—',
        rank: RANK_ORDER[priority] !== undefined ? RANK_ORDER[priority] : 3,
        priority,
        type: (f.issuetype && f.issuetype.name) || 'Задача',
        labels: (f.labels || []).join(','),
        est: f.timeoriginalestimate || 0,
        spent: f.timespent || 0,
        rem: f.timeestimate || 0,
        updated: f.updated ? f.updated.slice(0, 16).replace('T', ' ') : '',
        flagged: !!(f[FIELD_RESCHEDULE] && f[FIELD_RESCHEDULE] >= 3),
        custom: false
      };
      const linkedAbapKey = findLinkedAbapKey(issue);
      if (linkedAbapKey && abapByKey[linkedAbapKey]) {
        const af = abapByKey[linkedAbapKey].fields || {};
        item.abapChild = {
          key: linkedAbapKey,
          sum: af.summary || linkedAbapKey,
          assignee: (af.assignee && af.assignee.displayName) || '—',
          status: (af.status && af.status.name) || 'Новый',
          est: af.timeoriginalestimate || 0,
          spent: af.timespent || 0,
          rem: af.timeestimate || 0
        };
      }
      const start = f[FIELD_START];
      const planEnd = f[FIELD_PLAN_END];
      if (start && planEnd) {
        tasks.push({ ...item, s: start, e: planEnd });
      } else {
        backlog.push(item);
      }
    });

    res.json({ tasks, backlog, total: allIssues.length });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- Поиск пользователей (для назначения исполнителя) ----
app.get('/api/users', async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q) return res.json({ users: [] });
    const r = await jiraFetch(req, '/rest/api/3/user/search?query=' + encodeURIComponent(q) + '&maxResults=10');
    if (!r.ok) return res.status(r.status).json({ error: 'Ошибка поиска пользователей' });
    const list = await r.json();
    res.json({ users: list.map(u => ({ accountId: u.accountId, displayName: u.displayName })) });
  } catch (e) {
    res.status(e.status || 500).json({ error: await friendlyNetworkError(e, (function(){try{return new URL(req.session.jira.site).hostname;}catch(_){return null;}})()) });
  }
});

// ---- Обновление исполнителя в Jira ----
app.patch('/api/issues/:key/assignee', async (req, res) => {
  try {
    const { accountId } = req.body;
    const r = await jiraFetch(req, '/rest/api/3/issue/' + req.params.key + '/assignee', {
      method: 'PUT',
      body: JSON.stringify({ accountId: accountId || null })
    });
    if (r.status !== 204) {
      const t = await r.text();
      return res.status(r.status).json({ error: 'Jira отклонила изменение: ' + t.slice(0, 300) });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: await friendlyNetworkError(e, (function(){try{return new URL(req.session.jira.site).hostname;}catch(_){return null;}})()) });
  }
});

// ---- Обновление статуса в Jira (через доступные переходы) ----
app.patch('/api/issues/:key/status', async (req, res) => {
  try {
    const { statusName } = req.body;
    const trRes = await jiraFetch(req, '/rest/api/3/issue/' + req.params.key + '/transitions');
    if (!trRes.ok) return res.status(trRes.status).json({ error: 'Не удалось получить переходы статуса' });
    const trData = await trRes.json();
    const match = (trData.transitions || []).find(t => t.to && t.to.name === statusName);
    if (!match) {
      const available = (trData.transitions || []).map(t => t.to.name).join(', ');
      return res.status(409).json({ error: 'Из текущего статуса нельзя перейти в «' + statusName + '» напрямую. Доступные переходы: ' + (available || 'нет') });
    }
    const doRes = await jiraFetch(req, '/rest/api/3/issue/' + req.params.key + '/transitions', {
      method: 'POST',
      body: JSON.stringify({ transition: { id: match.id } })
    });
    if (doRes.status !== 204) {
      const t = await doRes.text();
      return res.status(doRes.status).json({ error: 'Jira отклонила переход: ' + t.slice(0, 300) });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: await friendlyNetworkError(e, (function(){try{return new URL(req.session.jira.site).hostname;}catch(_){return null;}})()) });
  }
});

// Автоматически открывает системный браузер — удобно для portable exe (собран через
// pkg), где нет ни терминала с явным npm-логом, ни привычки самому набирать localhost.
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start ""'
    : 'xdg-open';
  require('child_process').exec(cmd + ' ' + url, () => {});
}

app.listen(PORT, () => {
  console.log('');
  console.log('  Гант + Jira запущен:');
  console.log('    на этом компьютере:  http://localhost:' + PORT);
  lanAddresses().forEach(ip => {
    console.log('    из локальной сети:   http://' + ip + ':' + PORT);
  });
  if (lanAddresses().length) {
    console.log('  (для доступа с других компьютеров в той же сети/Wi-Fi может понадобиться');
    console.log('   разрешить входящие соединения на этот порт в файрволе)');
  }
  console.log('  Остановить сервер: Ctrl+C');
  console.log('');
  if (process.pkg) openBrowser('http://localhost:' + PORT);
});
