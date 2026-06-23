import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems, getSqlCompletionContext } from "@/lib/sqlCompletion";

describe("sqlCompletion quoted schema qualifiers", () => {
  it("parses quoted PostgreSQL schema names before a dot", () => {
    const sql = 'SELECT *\nFROM "order-management".';
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.qualifier).toBe("order-management");
    expect(context.prefix).toBe("");
    expect(context.suggestTables).toBe(true);
    expect(context.exclusiveColumnSuggestions).toBe(false);
  });

  it("suggests tables after a quoted schema qualifier", () => {
    const sql = 'SELECT *\nFROM "order-management".';
    const items = buildSqlCompletionItems(sql, sql.length, {
      dialect: "postgres",
      tables: [
        { name: "orders", schema: "order-management", type: "table" },
        { name: "shipments", schema: "order-management", type: "table" },
      ],
      columnsByTable: new Map(),
    });

    expect(items.some((item) => item.label === "orders" && item.type === "table")).toBe(true);
    expect(items.some((item) => item.label === "shipments" && item.type === "table")).toBe(true);
  });
});

describe("sqlCompletion table aliases", () => {
  it("applies generated aliases to table completions when enabled", () => {
    const sql = "SELECT * FROM ord";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "order_items", type: "table" }],
      columnsByTable: new Map(),
      autoAliasTables: true,
    });

    const table = items.find((item) => item.label === "order_items" && item.type === "table");
    expect(table?.apply).toBe("order_items AS oi");
  });

  it("keeps plain table completions when generated aliases are disabled", () => {
    const sql = "SELECT * FROM ord";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "order_items", type: "table" }],
      columnsByTable: new Map(),
      autoAliasTables: false,
    });

    const table = items.find((item) => item.label === "order_items" && item.type === "table");
    expect(table?.apply).toBe("order_items");
  });

  it("uses a numbered alias when the generated table alias already exists", () => {
    const sql = "SELECT * FROM order_items oi JOIN ord";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "order_items", type: "table" }],
      columnsByTable: new Map(),
      autoAliasTables: true,
    });

    const table = items.find((item) => item.label === "order_items" && item.type === "table");
    expect(table?.apply).toBe("order_items AS oi2");
  });

  it("applies generated aliases in comma-separated FROM table lists", () => {
    const sql = "SELECT * FROM users u, ord";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "order_items", type: "table" }],
      columnsByTable: new Map(),
      autoAliasTables: true,
    });

    const table = items.find((item) => item.label === "order_items" && item.type === "table");
    expect(table?.apply).toBe("order_items AS oi");
  });

  it("does not apply generated aliases to non-query table completions", () => {
    const sql = "INSERT INTO ord";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "order_items", type: "table" }],
      columnsByTable: new Map(),
      autoAliasTables: true,
    });

    const table = items.find((item) => item.label === "order_items" && item.type === "table");
    expect(table?.apply).toBe("order_items");
  });
});
