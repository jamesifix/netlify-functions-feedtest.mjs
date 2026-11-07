export default async () => {
  const r = await fetch("https://media.election.net.nz/xml/election.xml");
  const t = await r.text();
  return new Response(`Status: ${r.status}\n\n${t.slice(0, 500)}`);
};
export const config = { path: "/feedtest" };
