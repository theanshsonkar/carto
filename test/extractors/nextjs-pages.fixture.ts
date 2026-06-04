// Spec 11 fixture — Next.js Pages Router API route.
// Tested with synthetic path `pages/api/users/[id].ts`.
import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') return res.status(200).json({});
  return res.status(200).json([]);
}
