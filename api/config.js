function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function verifyAdmin(req, res) {
  if (!process.env.ADMIN_PIN) {
    send(res, 500, { error: 'ADMIN_PIN is missing. Add it in Vercel environment variables.' });
    return false;
  }
  if (req.headers['x-admin-pin'] !== process.env.ADMIN_PIN) {
    send(res, 401, { error: 'Wrong admin PIN.' });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    send(res, 200, { config: { localOnly: true, sharedTasksOnly: true } });
    return;
  }

  if (!verifyAdmin(req, res)) return;

  if (req.method === 'PUT') {
    send(res, 200, { config: { localOnly: true, sharedTasksOnly: true } });
    return;
  }

  res.setHeader('Allow', 'GET, PUT');
  send(res, 405, { error: 'Method not allowed.' });
}
