// End-to-end check of the MCP endpoint against a running Basic Cable (needs internet for Cinemeta).
//   MCP_URL=http://localhost:7000/mcp [MCP_TOKEN=password] [ADDON_URL=http://localhost:7099/manifest.json] node test/mcp-smoke.js
// Creates a channel called "MCP Smoke Test", exercises the tools, then deletes it.
import { strict as assert } from 'node:assert';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = new URL(process.env.MCP_URL || 'http://localhost:7000/mcp');
const headers = process.env.MCP_TOKEN ? { Authorization: `Bearer ${process.env.MCP_TOKEN}` } : {};
const client = new Client({ name: 'basiccable-smoke', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));

const show = (name, r) => {
  const t = r.content?.map((c) => c.text).join('\n') || '';
  console.log(`\n=== ${name}${r.isError ? ' (ERROR)' : ''}\n${t.length > 1500 ? `${t.slice(0, 1500)}…` : t}`);
  return t;
};
const call = async (name, args = {}, { expectError = false } = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = show(name, r);
  assert.equal(!!r.isError, expectError, `${name} ${expectError ? 'should have failed' : 'failed'}: ${t}`);
  return t;
};

const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);
assert.ok(tools.length >= 20);

const name = 'MCP Smoke Test';
let t = await call('basiccable_create_channel', {
  name, resolution: '720p', subtitles: 'soft', fill_mode: 'shuffle',
  pool: ['The Office', 'movie: Heat (1995)', 'Star Trek*', 'Zzqx Not A Real Show 9431'],
  slots: [
    { days: 'weeknights', start: '8pm', end: '9pm', content: 'Modern Family' },
    { days: 'saturday', start: '9am', length: '3h', content: 'pool', order: 'random' },
  ],
});
assert.match(t, /The Office/);
assert.match(t, /Heat \(movie/);
assert.match(t, /wildcard "Star Trek\*"/);
assert.match(t, /Not added:[\s\S]*Zzqx/);
assert.match(t, /Weekdays 8:00 PM–9:00 PM → Modern Family/);
assert.match(t, /Sat 9:00 AM–12:00 PM → auto-fill pool, random order/);

await call('basiccable_list_channels');
t = await call('basiccable_get_channel', { channel: name, guide_hours: 2 });
assert.match(t, /720p/);
await call('basiccable_update_channel', { channel: name, exclude_keywords: ['REMUX'], audio_language: 'eng' });
t = await call('basiccable_get_channel', { channel: name, guide_hours: 0 });
assert.match(t, /skip: REMUX/);
assert.match(t, /subtitles soft/, 'updating other options must keep subtitles=soft');
await call('basiccable_add_to_pool', { channel: name, titles: ['Parks and Recreation', 'Battlestar Galactica (2004)'] });
t = await call('basiccable_remove_from_pool', { channel: name, titles: ['Heat'] });
assert.match(t, /removed Heat/);
t = await call('basiccable_set_wildcard_exclusions', { channel: name, pattern: 'Star Trek*', exclude: ['Star Trek Continues'] });
assert.match(t, /excluded Star Trek Continues/);
t = await call('basiccable_add_slots', { channel: name, slots: [{ days: 'sun', start: '7pm', length: 120, content: 'movie: The Matrix' }] });
const slotId = Number(t.match(/\+ slot (\d+): Sun/)[1]);
t = await call('basiccable_remove_slots', { channel: name, slot_ids: [slotId] });
assert.match(t, /removed 1 slot/);
await call('basiccable_whats_on');
await call('basiccable_get_guide', { channel: name, hours: 1 });
await call('basiccable_search_titles', { query: 'Futurama', limit: 3 });
await call('basiccable_preview_wildcard', { pattern: 'Batman*', types: 'movie' });
await call('basiccable_get_settings');
await call('basiccable_server_status');
if (process.env.ADDON_URL) {
  await call('basiccable_add_stream_addon', { url: process.env.ADDON_URL });
  await call('basiccable_test_stream_addons');
  await call('basiccable_check_streams', { channel: name });
  t = await call('basiccable_remove_stream_addon', { addon: new URL(process.env.ADDON_URL).hostname });
  assert.match(t, /Removed/);
}
t = await call('basiccable_skip_current', { channel: name });
assert.match(t, /Skipped/);
await call('basiccable_bulk_update_channels', { channels: [name], round_minutes: 10 });
const backup = await client.callTool({ name: 'basiccable_export_backup', arguments: {} });
assert.ok(backup.structuredContent?.channels?.some((c) => c.name === name), 'backup should include the test channel');
console.log('\n=== basiccable_export_backup: ok');
// Bad input comes back as a readable tool error.
await call('basiccable_add_slots', { channel: name, slots: [{ days: 'someday', start: '8pm', length: 30, content: 'pool' }] }, { expectError: true });
await call('basiccable_get_channel', { channel: 'no such channel xyz' }, { expectError: true });
await call('basiccable_delete_channel', { channel: name });
await client.close();
console.log('\nMCP smoke test passed');
