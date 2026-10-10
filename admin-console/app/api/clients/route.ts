import { NextRequest, NextResponse } from "next/server";
import { backendFetch } from "@/lib/backend";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const res = await backendFetch(`/admin/clients?q=${encodeURIComponent(q)}`);
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const res = await backendFetch(`/admin/clients`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
