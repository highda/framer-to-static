#!/usr/bin/env node

import { readFileSync } from "fs";

function usage() {
  console.error("Usage: node scripts/inspect-framercms.js <path-to-file.framercms>");
  process.exit(1);
}

const filePath = process.argv[2];
if (!filePath) usage();

const bytes = readFileSync(filePath);

function previewString(value, max = 120) {
  if (typeof value !== "string") return value;
  return value.length > max ? value.slice(0, max) : value;
}

function makeReader(buffer) {
  let offset = 0;
  return {
    get offset() {
      return offset;
    },
    readU8() {
      const value = buffer.readUInt8(offset);
      offset += 1;
      return value;
    },
    readU16() {
      const value = buffer.readUInt16BE(offset);
      offset += 2;
      return value;
    },
    readU32() {
      const value = buffer.readUInt32BE(offset);
      offset += 4;
      return value;
    },
    readI8() {
      const value = buffer.readInt8(offset);
      offset += 1;
      return value;
    },
    readI64() {
      const value = Number(buffer.readBigInt64BE(offset));
      offset += 8;
      return value;
    },
    readF64() {
      const value = buffer.readDoubleBE(offset);
      offset += 8;
      return value;
    },
    readBytes(length) {
      const value = buffer.subarray(offset, offset + length);
      offset += length;
      return value;
    },
    readString() {
      const length = this.readU32();
      return this.readBytes(length).toString("utf8");
    },
    readJson() {
      return JSON.parse(this.readString());
    },
  };
}

function readTypedValue(reader) {
  const tag = reader.readU8();

  switch (tag) {
    case 0:
      return null;
    case 1: {
      const count = reader.readU16();
      return {
        type: "Array",
        value: Array.from({ length: count }, () => readTypedValue(reader)),
      };
    }
    case 2:
      return { type: "Boolean", value: reader.readU8() !== 0 };
    case 3:
      return { type: "Color", value: reader.readString() };
    case 4:
      return { type: "Date", value: new Date(reader.readI64()).toISOString() };
    case 5:
      return { type: "Enum", value: reader.readString() };
    case 6:
      return { type: "File", value: reader.readString() };
    case 7:
      return { type: "Link", value: reader.readJson() };
    case 8:
      return { type: "Number", value: reader.readF64() };
    case 9: {
      const count = reader.readU16();
      const value = {};
      for (let i = 0; i < count; i++) {
        value[reader.readString()] = readTypedValue(reader);
      }
      return { type: "Object", value };
    }
    case 10:
      return { type: "ResponsiveImage", value: reader.readJson() };
    case 11: {
      const marker = reader.readI8();
      if (marker === 0) return { type: "RichText", value: reader.readU32() };
      if (marker === 1) return { type: "RichText", value: reader.readString() };
      throw new Error(`Invalid rich text marker ${marker}`);
    }
    case 12:
      return { type: "String", value: reader.readString() };
    case 13:
      return { type: "VectorSetItem", value: reader.readU32() };
    default:
      throw new Error(`Unsupported typed value tag ${tag}`);
  }
}

function summarizeTypedValue(value) {
  if (value === null) return null;
  if (value.type === "Array") {
    return {
      type: value.type,
      length: value.value.length,
      preview: value.value.slice(0, 3).map(summarizeTypedValue),
    };
  }
  if (value.type === "Object") {
    return {
      type: value.type,
      keys: Object.keys(value.value),
      preview: Object.fromEntries(
        Object.entries(value.value)
          .slice(0, 4)
          .map(([key, inner]) => [key, summarizeTypedValue(inner)])
      ),
    };
  }
  if (typeof value.value === "string") {
    return { type: value.type, value: previewString(value.value) };
  }
  return value;
}

function inspectChunk() {
  const reader = makeReader(bytes);
  const recordCount = reader.readU32();
  const fieldCount = reader.readU16();
  const fields = [];

  for (let i = 0; i < fieldCount && reader.offset < bytes.length; i++) {
    const name = reader.readString();
    const tag = bytes.readUInt8(reader.offset);
    const value = readTypedValue(reader);
    fields.push({ index: i, name, tag, value: summarizeTypedValue(value) });
  }

  return {
    kind: "chunk",
    size: bytes.length,
    recordCount,
    fieldCount,
    parsedFields: fields.length,
    fields,
  };
}

function inspectIndex() {
  const reader = makeReader(bytes);
  const models = [];

  while (reader.offset < bytes.length) {
    const start = reader.offset;
    const collation = reader.readJson();
    const fieldCount = reader.readU8();
    const fieldNames = Array.from({ length: fieldCount }, () => reader.readString());
    const entryCount = reader.readU32();
    const sampleEntries = [];

    for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
      const values = fieldNames.map(() => readTypedValue(reader));
      const pointer = {
        chunkId: reader.readU16(),
        offset: reader.readU32(),
        length: reader.readU32(),
      };

      if (entryIndex < 3) {
        sampleEntries.push({
          index: entryIndex,
          values: values.map(summarizeTypedValue),
          pointer,
        });
      }
    }

    models.push({
      index: models.length,
      start,
      end: reader.offset,
      size: reader.offset - start,
      collation,
      fieldNames,
      entryCount,
      sampleEntries,
    });
  }

  return {
    kind: "index",
    size: bytes.length,
    modelCount: models.length,
    models,
  };
}

const result = filePath.includes("-chunk-") ? inspectChunk() : inspectIndex();
console.log(JSON.stringify(result, null, 2));
