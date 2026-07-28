import { describe, expect, it } from "vitest";
import { buildPublishFormData } from "./publish-form-data";

function makeFile(): File {
  return new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" });
}

const EMPTY_FIELDS = {
  title: "",
  description: "",
  alt: "",
  tags: "",
  license: "",
  location: "",
  capturedAt: "",
  keepGps: false,
};

describe("buildPublishFormData", () => {
  it("always sets the file field", () => {
    const file = makeFile();
    const fd = buildPublishFormData(file, EMPTY_FIELDS);
    expect(fd.get("file")).toBe(file);
  });

  it("sets every non-empty text field", () => {
    const fd = buildPublishFormData(makeFile(), {
      ...EMPTY_FIELDS,
      title: "Low tide",
      description: "Herons at dusk",
      alt: "A heron standing in shallow water",
      tags: "heron, shorebird",
      license: "CC BY-NC 4.0",
      location: "Overpeck County Park, NJ",
      capturedAt: "2026-06-01T18:30:00.000Z",
    });

    expect(fd.get("title")).toBe("Low tide");
    expect(fd.get("description")).toBe("Herons at dusk");
    expect(fd.get("alt")).toBe("A heron standing in shallow water");
    expect(fd.get("tags")).toBe("heron, shorebird");
    expect(fd.get("license")).toBe("CC BY-NC 4.0");
    expect(fd.get("location")).toBe("Overpeck County Park, NJ");
    expect(fd.get("capturedAt")).toBe("2026-06-01T18:30:00.000Z");
  });

  it("omits empty-string fields entirely rather than setting them to ''", () => {
    const fd = buildPublishFormData(makeFile(), EMPTY_FIELDS);
    expect(fd.has("title")).toBe(false);
    expect(fd.has("description")).toBe(false);
    expect(fd.has("alt")).toBe(false);
    expect(fd.has("tags")).toBe(false);
    expect(fd.has("license")).toBe(false);
    expect(fd.has("location")).toBe(false);
    expect(fd.has("capturedAt")).toBe(false);
  });

  it("sets keepGps='true' only when true, and omits it entirely when false", () => {
    expect(buildPublishFormData(makeFile(), { ...EMPTY_FIELDS, keepGps: true }).get("keepGps")).toBe("true");
    expect(buildPublishFormData(makeFile(), { ...EMPTY_FIELDS, keepGps: false }).has("keepGps")).toBe(false);
  });
});
