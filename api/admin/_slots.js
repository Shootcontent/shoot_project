/**
 * GET    /api/admin/slots?studio=curve&date=YYYY-MM-DD  — list blocks for a date
 * GET    /api/admin/slots?all=1                          — list all blocks
 * POST   /api/admin/slots                               — create block
 * DELETE /api/admin/slots?blockId=BLK-xxx               — remove block
 * DELETE /api/admin/slots?clearDate=YYYY-MM-DD          — clear ALL slot data for a date
 */

import { requireSession } from '../_admin-auth.js';
import { createBlock, removeBlock, listBlocksForDate, listAllBlocks } from '../_slot-block.js';
import { auditLog } from '../_audit.js';
import { kv } from '../_kv.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = await requireSession(req, res);
  if (!session) return;

  // ── GET — list blocks ────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      if (req.query.all === '1') {
        const blocks = await listAllBlocks();
        return res.status(200).json({ blocks });
      }
      const { studio, date } = req.query;
      if (!studio || !date) return res.status(400).json({ error: 'studio and date required.' });
      const blocks = await listBlocksForDate(studio, date);
      return res.status(200).json({ blocks });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST — create block ──────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { studio, date, time, duration, scope, reason } = req.body || {};
    if (!studio || !date || !scope) return res.status(400).json({ error: 'studio, date and scope required.' });
    try {
      const block = await createBlock({ studio, date, time, duration, scope, reason, blockedBy: session.username });
      auditLog(session.username, 'slot.block', 'slot', `${studio}:${date}:${time || 'full_day'}`, { scope, reason, blockId: block.blockId });
      return res.status(201).json({ block });
    } catch (err) {
      return res.status(err.message.includes('busy') ? 409 : 400).json({ error: err.message });
    }
  }

  // ── DELETE — remove block ────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { blockId, clearDate } = req.query;

    // ── Clear all slot data for a date ──────────────────────────────────────
    if (clearDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(clearDate)) {
        return res.status(400).json({ error: 'Invalid date format.' });
      }
      const STUDIOS = ['curve', 'studio1', 'pool'];
      let cleared = 0;
      try {
        for (const studio of STUDIOS) {
          // Remove admin blocks for this studio+date
          const blockIds = await kv('SMEMBERS', `slot:idx:blocks:${studio}:${clearDate}`);
          if (blockIds && blockIds.length) {
            for (const bid of blockIds) {
              await kv('HDEL', `booking:intervals:${studio}:${clearDate}`, `b:${bid}`);
              await kv('SREM', 'slot:idx:all-blocks', bid);
              await kv('DEL', `slot:block:${bid}`);
              cleared++;
            }
            await kv('DEL', `slot:idx:blocks:${studio}:${clearDate}`);
          }
          // Clear full intervals hash (pending + confirmed entries)
          await kv('DEL', `booking:intervals:${studio}:${clearDate}`);
          // Clear individual slot keys
          const slotKeys = await kv('KEYS', `booking:slot:${studio}:${clearDate}:*`);
          if (slotKeys && slotKeys.length) {
            for (const k of slotKeys) { await kv('DEL', k); cleared++; }
          }
          // Release any stale locks
          await kv('DEL', `booking:lock:${studio}:${clearDate}`);
        }
        auditLog(session.username, 'slot.clear-date', 'slot', clearDate, { cleared });
        return res.status(200).json({ ok: true, cleared });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    if (!blockId) return res.status(400).json({ error: 'blockId or clearDate required.' });
    try {
      const result = await removeBlock(blockId, session.username);
      auditLog(session.username, 'slot.unblock', 'slot', blockId, result);
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(err.message === 'Block not found.' ? 404 : 500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}
