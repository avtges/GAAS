import { describe, it, expect } from "vitest";
import { pgConnectionConfig } from "@/lib/db/pool";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

describe("database TLS configuration", () => {
  it("uses no TLS for local databases", () => {
    expect(pgConnectionConfig("postgresql://postgres:postgres@127.0.0.1:5432/db").ssl).toBe(false);
  });
  it("encrypts remote connections and strips URL ssl params that would override the options", () => {
    const c = pgConnectionConfig("postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require&pgbouncer=true");
    expect(c.ssl).toEqual({ rejectUnauthorized: false });
    expect(c.connectionString).not.toContain("sslmode");
    expect(c.connectionString).toContain("pgbouncer=true");
  });
  it("verifies the certificate when a CA is provided (PEM or base64)", () => {
    expect(pgConnectionConfig("postgresql://u:p@db.example.com/x", PEM).ssl).toEqual({ rejectUnauthorized: true, ca: PEM });
    expect(pgConnectionConfig("postgresql://u:p@db.example.com/x", Buffer.from(PEM).toString("base64")).ssl).toEqual({ rejectUnauthorized: true, ca: PEM });
    expect(() => pgConnectionConfig("postgresql://u:p@db.example.com/x", "not a cert")).toThrow(/PEM/);
  });
});
