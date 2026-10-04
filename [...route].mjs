import serverPkg from '../server.cjs';

const { handler } = serverPkg;

class ResponseCollector {
  constructor() {
    this.headers = new Headers();
    this.statusCode = 200;
    this.headersSent = false;
    this.body = null;
  }
  setHeader(name, value) {
    this.headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    this.headersSent = true;
  }
  end(body = '') {
    if (body !== undefined && body !== null) this.body = body;
    else this.body = '';
    this.headersSent = true;
  }
}

function makeReq(request) {
  const url = new URL(request.url);
  const headers = {};
  for (const [k, v] of request.headers.entries()) headers[k.toLowerCase()] = v;
  const req = {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    socket: { remoteAddress: '0.0.0.0', encrypted: url.protocol === 'https:' },
    webRequest: request,
    on() {},
  };
  return req;
}

export default async function (request) {
  const req = makeReq(request);
  const res = new ResponseCollector();
  try {
    await handler(req, res);
    return new Response(res.body ?? '', { status: res.statusCode, headers: res.headers });
  } catch (error) {
    return Response.json(process.env.BENGA_DEBUG === '1' ? { error: 'Erro interno. Tente novamente.', details: String(error?.message || error) } : { error: 'Erro interno. Tente novamente.' }, { status: 500 });
  }
}
