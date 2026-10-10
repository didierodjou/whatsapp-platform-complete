import { NextRequest, NextResponse } from "next/server";
import { backendFetch } from "@/lib/backend";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const res = await backendFetch(`/admin/clients/${params.id}`);
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const res = await backendFetch(`/admin/clients/${params.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const res = await backendFetch(`/admin/clients/${params.id}`, { method: "DELETE" });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
