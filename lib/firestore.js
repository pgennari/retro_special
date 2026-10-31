/*
 * Cliente mínimo do Firestore (REST) usando só módulos nativos do Node.
 *
 * A autenticação é feita com a service account do Firebase: JWT RS256
 * assinado com crypto + troca por access token no OAuth2 do Google.
 * Nenhuma dependência externa é necessária.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';
const SCOPE = 'https://www.googleapis.com/auth/datastore';

function b64url(value) {
  return Buffer.from(value).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlBuffer(buffer) {
  return Buffer.from(buffer).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function loadCredentials() {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (inline && inline.trim()) {
    const text = inline.trim();
    const json = text.charAt(0) === '{' ? text : Buffer.from(text, 'base64').toString('utf8');
    return JSON.parse(json);
  }

  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (file) {
    return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * conversão de valores JS <-> tipos do Firestore
 * ------------------------------------------------------------------ */

function encodeValue(value) {
  if (value === undefined || value === null) return { nullValue: null };

  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { nullValue: null };
    if (Number.isInteger(value)) return { integerValue: String(value) };
    return { doubleValue: value };
  }

  if (Array.isArray(value)) {
    return value.length
      ? { arrayValue: { values: value.map(encodeValue) } }
      : { arrayValue: {} };
  }

  if (typeof value === 'object') {
    return { mapValue: { fields: encodeFields(value) } };
  }

  return { nullValue: null };
}

function encodeFields(value) {
  const fields = {};
  const source = value && typeof value === 'object' ? value : {};
  Object.keys(source).forEach((key) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
    if (source[key] === undefined) return;
    fields[key] = encodeValue(source[key]);
  });
  return fields;
}

function decodeValue(value) {
  if (!value || typeof value !== 'object') return null;

  if (value.stringValue !== undefined) return value.stringValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return Number(value.doubleValue);
  if (value.booleanValue !== undefined) return !!value.booleanValue;
  if (value.nullValue !== undefined) return null;
  if (value.timestampValue !== undefined) return value.timestampValue;
  if (value.bytesValue !== undefined) return value.bytesValue;
  if (value.referenceValue !== undefined) return value.referenceValue;
  if (value.geoPointValue !== undefined) return value.geoPointValue;

  if (value.arrayValue !== undefined) {
    const values = (value.arrayValue && value.arrayValue.values) || [];
    return values.map(decodeValue);
  }

  if (value.mapValue !== undefined) {
    return decodeFields((value.mapValue && value.mapValue.fields) || {});
  }

  return null;
}

function decodeFields(fields) {
  const out = {};
  Object.keys(fields || {}).forEach((key) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
    out[key] = decodeValue(fields[key]);
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * cliente REST
 * ------------------------------------------------------------------ */

function httpError(status, message, body) {
  const error = new Error(message || ('Firestore respondeu ' + status + '.'));
  error.status = status;
  error.body = body || null;
  if (status === 404) error.notFound = true;
  if (status === 409) error.conflict = true;
  return error;
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createClient(credentials, options) {
  if (!credentials || !credentials.client_email || !credentials.private_key) {
    throw new Error('Service account do Firebase inválida: faltam client_email/private_key.');
  }

  const projectId = (options && options.projectId) || process.env.FIREBASE_PROJECT_ID || credentials.project_id;
  if (!projectId) throw new Error('Informe o projeto do Firebase (FIREBASE_PROJECT_ID).');

  const base = (options && options.baseUrl) ||
    (FIRESTORE_BASE + '/projects/' + encodeURIComponent(projectId) + '/databases/(default)/documents');
  const tokenUri = (options && options.tokenUri) || credentials.token_uri || TOKEN_URL;

  let accessToken = '';
  let tokenExpiresAt = 0;
  let tokenPromise = null;

  async function fetchAccessToken() {
    if (typeof fetch !== 'function') {
      throw new Error('Este Node não tem fetch nativo. Use Node 18 ou superior.');
    }

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: credentials.client_email,
      scope: SCOPE,
      aud: tokenUri,
      iat: now,
      exp: now + 3600
    };

    const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claims));
    let signature;
    try {
      signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(credentials.private_key);
    } catch (error) {
      throw new Error('Não consegui assinar o token da service account: ' + error.message);
    }

    const assertion = signingInput + '.' + b64urlBuffer(signature);
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: assertion
    }).toString();

    let response;
    try {
      response = await fetch(tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: timeoutSignal(10000)
      });
    } catch (error) {
      throw new Error('Não consegui falar com o OAuth2 do Google: ' + error.message);
    }

    let data = null;
    try { data = await response.json(); } catch (error) { data = null; }
    if (!response.ok || !data || !data.access_token) {
      const detail = data && (data.error_description || data.error) ? (data.error_description || data.error) : response.status;
      throw new Error('O Google recusou a autenticação da service account (' + detail + ').');
    }

    accessToken = data.access_token;
    const expiresIn = Number(data.expires_in) || 3600;
    tokenExpiresAt = Date.now() + expiresIn * 1000;
    return accessToken;
  }

  async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiresAt - 60000) return accessToken;
    if (tokenPromise) return tokenPromise;
    tokenPromise = fetchAccessToken().finally(() => { tokenPromise = null; });
    return tokenPromise;
  }

  function documentPath(parts) {
    return '/' + parts.map((part) => encodeURIComponent(String(part))).join('/');
  }

  async function api(method, resource, body, attempt) {
    const tries = attempt || 0;
    const token = await getAccessToken();
    let response;
    try {
      response = await fetch(base + resource, {
        method,
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeoutSignal(12000)
      });
    } catch (error) {
      throw httpError(0, 'Falha de rede ao falar com o Firestore: ' + error.message);
    }

    if (response.status === 401 && tries === 0) {
      accessToken = '';
      tokenExpiresAt = 0;
      return api(method, resource, body, tries + 1);
    }

    if ((response.status === 429 || response.status >= 500) && tries < 2) {
      await sleep(300 * (tries + 1));
      return api(method, resource, body, tries + 1);
    }

    let text = '';
    try { text = await response.text(); } catch (error) { text = ''; }
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (error) { data = null; }
    }

    if (!response.ok) {
      const detail = data && data.error && data.error.message ? data.error.message : ('Firestore respondeu ' + response.status + '.');
      throw httpError(response.status, detail, data);
    }

    return data;
  }

  function decodeDocument(document) {
    if (!document) return null;
    const name = document.name || '';
    return {
      id: name.slice(name.lastIndexOf('/') + 1),
      data: decodeFields(document.fields || {})
    };
  }

  async function get(parts) {
    try {
      const data = await api('GET', documentPath(parts));
      const decoded = decodeDocument(data);
      return decoded ? decoded.data : null;
    } catch (error) {
      if (error.notFound) return null;
      throw error;
    }
  }

  async function create(collectionParts, id, value) {
    const resource = documentPath(collectionParts) + '?documentId=' + encodeURIComponent(String(id));
    const data = await api('POST', resource, { fields: encodeFields(value) });
    return decodeDocument(data);
  }

  async function set(parts, value) {
    const data = await api('PATCH', documentPath(parts), { fields: encodeFields(value) });
    return decodeDocument(data);
  }

  async function remove(parts) {
    try {
      await api('DELETE', documentPath(parts));
    } catch (error) {
      if (!error.notFound) throw error;
    }
  }

  async function list(collectionParts) {
    const documents = [];
    let pageToken = '';
    let pages = 0;

    do {
      let resource = documentPath(collectionParts) + '?pageSize=300';
      if (pageToken) resource += '&pageToken=' + encodeURIComponent(pageToken);
      const data = await api('GET', resource);
      (data && data.documents ? data.documents : []).forEach((doc) => {
        const decoded = decodeDocument(doc);
        if (decoded) documents.push(decoded);
      });
      pageToken = data && data.nextPageToken ? data.nextPageToken : '';
      pages += 1;
    } while (pageToken && pages < 20);

    return documents;
  }

  return {
    projectId,
    get,
    create,
    set,
    remove,
    list
  };
}

function createClientFromEnv() {
  const credentials = loadCredentials();
  if (!credentials) return null;
  return createClient(credentials, {
    projectId: process.env.FIREBASE_PROJECT_ID || credentials.project_id
  });
}

module.exports = {
  createClient,
  createClientFromEnv,
  loadCredentials,
  _internals: {
    encodeValue,
    encodeFields,
    decodeValue,
    decodeFields
  }
};
