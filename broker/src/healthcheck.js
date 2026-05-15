const port = process.env.BROKER_PORT || 17890;
const res = await fetch(`http://127.0.0.1:${port}/health`);
if (!res.ok) process.exit(1);
