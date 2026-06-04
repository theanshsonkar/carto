// Spec 11 fixture — Next.js App Router route handler.
// Tested with synthetic path `app/api/users/route.ts`.
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  return NextResponse.json([]);
}

export async function POST(request: Request) {
  const body = await request.json();
  return NextResponse.json(body);
}
