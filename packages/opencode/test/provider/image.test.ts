import { describe, expect, test } from "bun:test"
import { PNG } from "pngjs"
import jpeg from "jpeg-js"
import { compressImage, downscale, DEFAULT_MAX_IMAGE_BYTES } from "../../src/provider/image"

// --- helpers -------------------------------------------------------------

// Build an RGBA pixel buffer via a per-pixel painter, as pngjs/jpeg-js expect.
function makePixels(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]) {
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const [r, g, b, a] = paint(x, y)
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
  }
  return { data, width, height }
}

function encodePng(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]) {
  const png = new PNG({ width, height })
  const pixels = makePixels(width, height, paint)
  pixels.data.copy(png.data)
  return PNG.sync.write(png)
}

function encodeJpeg(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number],
  quality = 90,
) {
  const pixels = makePixels(width, height, paint)
  return Buffer.from(jpeg.encode({ data: Buffer.from(pixels.data), width, height }, quality).data)
}

function base64Bytes(b64: string) {
  return Buffer.from(b64, "base64").length
}

// --- downscale: dimensions ----------------------------------------------

describe("downscale - output dimensions", () => {
  const src = makePixels(100, 80, () => [10, 20, 30, 255])

  test.each([
    [0.5, 50, 40],
    [0.25, 25, 20],
    [0.15, 15, 12],
    [0.1, 10, 8],
  ])("scale %p -> %p x %p", (scale, w, h) => {
    const out = downscale(src, scale)
    expect(out.width).toBe(w)
    expect(out.height).toBe(h)
    expect(out.data.length).toBe(w * h * 4)
  })

  test("never produces a zero dimension (clamped to >= 1)", () => {
    const out = downscale(makePixels(3, 3, () => [0, 0, 0, 255]), 0.01)
    expect(out.width).toBeGreaterThanOrEqual(1)
    expect(out.height).toBeGreaterThanOrEqual(1)
  })
})

// --- downscale: area-averaging correctness ------------------------------

describe("downscale - area-averaging correctness", () => {
  // A 2x2 image with four distinct colors, halved to 1x1, must average all four.
  // Nearest-neighbor would pick a single corner and get this wrong.
  test("2x2 distinct colors halve to their average", () => {
    const src = makePixels(2, 2, (x, y) => {
      if (x === 0 && y === 0) return [0, 0, 0, 255] // black
      if (x === 1 && y === 0) return [255, 0, 0, 255] // red
      if (x === 0 && y === 1) return [0, 255, 0, 255] // green
      return [0, 0, 255, 255] // blue
    })
    const out = downscale(src, 0.5)
    expect(out.width).toBe(1)
    expect(out.height).toBe(1)
    // mean of {0,255,0,0}=63.75->64 ; {0,0,255,0}=63.75->64 ; {0,0,0,255}=63.75->64
    expect(out.data[0]).toBe(64) // R: (0+255+0+0)/4
    expect(out.data[1]).toBe(64) // G: (0+0+255+0)/4
    expect(out.data[2]).toBe(64) // B: (0+0+0+255)/4
    expect(out.data[3]).toBe(255) // fully opaque
  })

  // The value a nearest-neighbor sampler would return for this block is one of
  // the four corners (0 or 255), never the average (64). Prove we differ.
  test("differs from nearest-neighbor point-sampling", () => {
    const src = makePixels(2, 2, (x, y) => {
      if (x === 0 && y === 0) return [0, 0, 0, 255]
      if (x === 1 && y === 0) return [255, 0, 0, 255]
      if (x === 0 && y === 1) return [0, 255, 0, 255]
      return [0, 0, 255, 255]
    })
    const out = downscale(src, 0.5)
    expect([0, 255]).not.toContain(out.data[0])
  })

  // A uniform image must downscale to exactly the same uniform color (no drift).
  test("uniform color is preserved exactly", () => {
    const src = makePixels(40, 40, () => [123, 45, 200, 255])
    const out = downscale(src, 0.25)
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(123)
      expect(out.data[i + 1]).toBe(45)
      expect(out.data[i + 2]).toBe(200)
      expect(out.data[i + 3]).toBe(255)
    }
  })

  // A sharp black/white vertical split, halved, yields mid-gray at the seam
  // (averaging) rather than a hard 0-or-255 edge (nearest-neighbor).
  test("high-contrast edge blends toward gray (anti-aliasing)", () => {
    const src = makePixels(4, 2, (x) => (x < 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]))
    // 4x2 -> 2x1: each dest pixel covers one solid half, so still 0 and 255.
    const half = downscale(src, 0.5)
    expect(half.data[0]).toBe(0)
    expect(half.data[4]).toBe(255)
    // 4x2 -> 3x1 forces a dest pixel straddling the seam -> intermediate gray.
    const three = downscale(src, 0.75)
    expect(three.width).toBe(3)
    const mid = three.data[4] // middle pixel R channel
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(255)
  })

  // Fully-transparent source must not drag RGB toward black in the average.
  test("fully transparent region keeps alpha at 0", () => {
    const src = makePixels(2, 2, () => [255, 255, 255, 0])
    const out = downscale(src, 0.5)
    expect(out.data[3]).toBe(0)
  })
})

// --- downscale: UPSTREAM CROSS-VALIDATION (golden reference values) ------
//
// The tests above are self-validating: they assert properties of our own
// output. These tests instead pin our output against AUTHORITATIVE reference
// values generated OFFLINE, so a silent regression (or a subtly wrong
// fractional-edge weight) can't slip through by staying "self-consistent".
//
// Two references are used, and the split is deliberate:
//
//   1. INTEGER-RATIO downscales are cross-checked against Pillow's
//      Image.resize(..., Resampling.BOX) — the canonical box filter. For
//      integer ratios Pillow BOX IS exact area-averaging, and our impl matches
//      it byte-for-byte (verified: 4->2, 8->4). This is the strongest possible
//      cross-validation: an independent, widely-trusted C implementation.
//
//   2. NON-INTEGER-RATIO downscales are cross-checked against an independently
//      derived EXACT-AREA reference (continuous area integration with
//      fractional edge weights), NOT against Pillow BOX. This is intentional:
//      Pillow BOX and our filter use *different definitions* for non-integer
//      scales (see the note on the 4->3 case below). Ours is the exact
//      area-average; Pillow BOX snaps its window to whole source pixels. We
//      verified the divergence is definitional, not a bug — our output equals
//      the exact-area math to within rounding, which is the more accurate
//      area filter for anti-aliasing screenshots.
//
// Golden values were produced with Python (Pillow 12.2.0 for BOX; a from-scratch
// double-precision area integrator for exact-area) against fixed source images,
// then hard-coded here. NO Pillow/sharp runtime dependency is added.

describe("downscale - cross-validation against upstream golden values", () => {
  // Compare a downscale() result to a flat [r,g,b,a, r,g,b,a, ...] golden array.
  // tol is the max allowed per-channel abs difference (rounding slack, documented
  // per case). tol=0 means byte-for-byte identical to the reference.
  function expectPixels(out: { data: Uint8Array | Buffer; width: number; height: number }, golden: number[], tol: number) {
    expect(out.data.length).toBe(golden.length)
    for (let i = 0; i < golden.length; i++) {
      const diff = Math.abs(out.data[i]! - golden[i]!)
      if (diff > tol) {
        const ch = ["R", "G", "B", "A"][i % 4]
        throw new Error(`pixel ${Math.floor(i / 4)} ${ch}: got ${out.data[i]}, golden ${golden[i]} (diff ${diff} > tol ${tol})`)
      }
    }
  }

  // A 4x4 RGB block image: R increases left->right (0,60,120,180),
  // G increases top->bottom (0,60,120,180), all fully opaque.
  const gridA = makePixels(4, 4, (x, y) => [x * 60, y * 60, 0, 255])

  // INTEGER ratio 4->2 (scale 0.5). Pillow BOX golden (exact, tol=0):
  //   [[(30,30,0),(150,30,0)], [(30,150,0),(150,150,0)]]
  // Each 2x2 source block averages cleanly: R col-means {0,60}->30, {120,180}->150.
  test("4->2 (integer) matches Pillow BOX exactly", () => {
    // prettier-ignore
    const pillowBox = [
      30, 30, 0, 255,   150, 30, 0, 255,
      30, 150, 0, 255,  150, 150, 0, 255,
    ]
    expectPixels(downscale(gridA, 0.5), pillowBox, 0)
  })

  // NON-INTEGER ratio 4->3 (scale 0.75, ratio 4/3). THIS is where a box-filter
  // impl is most likely to diverge from a reference. Our exact-area golden:
  //   [[(15,15,0),(90,15,0),(165,15,0)], ...]  (R col-weighted-means with the
  //   fractional 1/3 overlap at each region edge).
  //
  // NOTE — deliberate divergence from Pillow BOX: Pillow BOX for 4->3 rounds its
  // sampling window to WHOLE source pixels (int(center +/- 0.5*scale + 0.5)), so it
  // reports (0,0,0) for dest[0][0] — sampling only source col 0. Our filter uses
  // exact fractional edge weights: dest[0][0] covers source x in [0, 1.333], so
  // col 0 gets weight 1.0 and col 1 gets weight 0.333 -> R = 60*0.333/1.333 = 15.
  // Ours is the true area average (the mathematically exact box filter); Pillow's
  // integer-snapping is a coarser approximation. Cross-checked against an
  // independent double-precision area integrator (tol=0, they agree exactly).
  test("4->3 (non-integer) matches exact-area reference (documented Pillow-BOX divergence)", () => {
    // prettier-ignore
    const exactArea = [
      15, 15, 0, 255,   90, 15, 0, 255,    165, 15, 0, 255,
      15, 90, 0, 255,   90, 90, 0, 255,    165, 90, 0, 255,
      15, 165, 0, 255,  90, 165, 0, 255,   165, 165, 0, 255,
    ]
    expectPixels(downscale(gridA, 0.75), exactArea, 0)

    // Prove the divergence is real: our result is NOT Pillow BOX's integer-snapped
    // value for the top-left pixel (Pillow would give R=0; exact-area gives R=15).
    expect(downscale(gridA, 0.75).data[0]).toBe(15)
  })

  // 8x8: left half red, right half blue; top 4 rows bright (200), bottom dim (100).
  const gridB = makePixels(8, 8, (x, y) => (x < 4 ? [y < 4 ? 200 : 100, 0, 0, 255] : [0, 0, y < 4 ? 200 : 100, 255]))

  // INTEGER ratio 8->4 (scale 0.5). Pillow BOX golden (exact, tol=0): each dest
  // pixel sits entirely within one solid quadrant, so no blending occurs.
  test("8->4 (integer) matches Pillow BOX exactly", () => {
    // prettier-ignore
    const pillowBox = [
      200, 0, 0, 255,  200, 0, 0, 255,   0, 0, 200, 255,  0, 0, 200, 255,
      200, 0, 0, 255,  200, 0, 0, 255,   0, 0, 200, 255,  0, 0, 200, 255,
      100, 0, 0, 255,  100, 0, 0, 255,   0, 0, 100, 255,  0, 0, 100, 255,
      100, 0, 0, 255,  100, 0, 0, 255,   0, 0, 100, 255,  0, 0, 100, 255,
    ]
    expectPixels(downscale(gridB, 0.5), pillowBox, 0)
  })

  // NON-INTEGER ratio 8->3 (scale 0.375, ratio 8/3). Here Pillow BOX AND our
  // exact-area filter AGREE (verified byte-for-byte), because the region edges
  // land such that the fractional weights and Pillow's integer window coincide.
  // Golden (both references, tol=0):
  //   [[(200,0,0),(100,0,100),(0,0,200)], [(150,..),(75,..)..], [(100,..)..]]
  // The center column straddles the red/blue seam and correctly blends to purple.
  test("8->3 (non-integer) matches Pillow BOX exactly (fractional seam blend)", () => {
    // prettier-ignore
    const pillowBox = [
      200, 0, 0, 255,  100, 0, 100, 255,  0, 0, 200, 255,
      150, 0, 0, 255,  75, 0, 75, 255,    0, 0, 150, 255,
      100, 0, 0, 255,  50, 0, 50, 255,    0, 0, 100, 255,
    ]
    expectPixels(downscale(gridB, 0.375), pillowBox, 0)
  })

  // NON-INTEGER ratio 5->2 (scale 0.4, ratio 2.5) with a single bright corner
  // pixel over a uniform (10,20,30) field. Exact-area golden for dest[0][0]:
  // covers source [0,2.5]x[0,2.5] = 6.25 area; the lone bright (250) pixel has
  // weight 1, the rest weight 5.25 -> R = (250 + 10*5.25)/6.25 = 48.4 -> 48.
  // (Pillow BOX would snap the window to a 3x3 whole-pixel box and give R=37 —
  // another instance of the documented integer-snapping divergence.)
  test("5->2 (non-integer) matches exact-area reference for a lone bright pixel", () => {
    const gridC = makePixels(5, 5, (x, y) => (x === 0 && y === 0 ? [250, 250, 250, 255] : [10, 20, 30, 255]))
    // prettier-ignore
    const exactArea = [
      48, 57, 65, 255,  10, 20, 30, 255,
      10, 20, 30, 255,  10, 20, 30, 255,
    ]
    expectPixels(downscale(gridC, 0.4), exactArea, 0)
  })

  // ALPHA-WEIGHTED path cross-validation (not exercised by the integer/RGB cases
  // above). References derived by the same independent area integrator, extended
  // for our documented alpha semantics: RGB averaged weighted by (alpha*area);
  // alpha is a plain area average; a fully-transparent region keeps RGB at 0.

  // 2x2: one opaque white pixel + three fully-transparent. 2->1.
  // RGB must stay pure white (255) because transparent pixels carry zero
  // alpha-weight and cannot drag color toward black. Alpha = 255/4 = 63.75 -> 64.
  test("2->1 alpha-weighted: opaque white survives among transparent (no darkening)", () => {
    const src = makePixels(2, 2, (x, y) => (x === 0 && y === 0 ? [255, 255, 255, 255] : [0, 0, 0, 0]))
    expectPixels(downscale(src, 0.5), [255, 255, 255, 64], 0)
  })

  // 4x4: left two columns opaque red, right two columns fully-transparent green.
  // 4->2: left dest pixels stay solid red (alpha 255); right dest pixels are
  // fully transparent, so RGB collapses to 0 (rw==0 branch) and alpha to 0.
  test("4->2 alpha-weighted: transparent columns collapse RGB to 0", () => {
    const src = makePixels(4, 4, (x) => (x < 2 ? [200, 0, 0, 255] : [0, 255, 0, 0]))
    // prettier-ignore
    const golden = [
      200, 0, 0, 255,  0, 0, 0, 0,
      200, 0, 0, 255,  0, 0, 0, 0,
    ]
    expectPixels(downscale(src, 0.5), golden, 0)
  })
})

// --- compressImage: shrinks under the cap -------------------------------

describe("compressImage - brings oversized images under the cap", () => {
  // A large noisy PNG: noise defeats PNG's own compression so the source is big,
  // and forces the JPEG ladder to actually step down quality/scale.
  function noisyPng(size: number) {
    let seed = 12345
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % 256
    }
    return encodePng(size, size, () => [rand(), rand(), rand(), 255])
  }

  test("large PNG is compressed to valid JPEG base64 under maxBytes", () => {
    const bytes = noisyPng(900) // ~900x900 noise -> comfortably > cap once raw
    const maxBytes = 200_000
    const out = compressImage("image/png", bytes, maxBytes)
    expect(out).toBeDefined()
    expect(out!.mediaType).toBe("image/jpeg")
    // Decoded output really is under the cap.
    expect(base64Bytes(out!.data)).toBeLessThanOrEqual(maxBytes)
    // ...and really is a decodable JPEG.
    const decoded = jpeg.decode(Buffer.from(out!.data, "base64"), { useTArray: true })
    expect(decoded.width).toBeGreaterThan(0)
    expect(decoded.height).toBeGreaterThan(0)
  })

  test("respects DEFAULT_MAX_IMAGE_BYTES for a genuinely huge image", () => {
    const bytes = noisyPng(1600)
    const out = compressImage("image/png", bytes, DEFAULT_MAX_IMAGE_BYTES)
    expect(out).toBeDefined()
    expect(base64Bytes(out!.data)).toBeLessThanOrEqual(DEFAULT_MAX_IMAGE_BYTES)
  })

  // The quality/scale ladder must shrink progressively: a tighter cap must not
  // produce a LARGER output than a looser cap for the same source.
  test("tighter cap yields a smaller (or equal) output", () => {
    const bytes = noisyPng(700)
    const loose = compressImage("image/png", bytes, 300_000)
    const tight = compressImage("image/png", bytes, 60_000)
    expect(loose).toBeDefined()
    expect(tight).toBeDefined()
    expect(base64Bytes(tight!.data)).toBeLessThanOrEqual(base64Bytes(loose!.data))
    expect(base64Bytes(tight!.data)).toBeLessThanOrEqual(60_000)
  })
})

// --- compressImage: already-small round-trips ---------------------------

describe("compressImage - image already under the cap", () => {
  test("small image returns valid JPEG within the cap (scale=1 path)", () => {
    const bytes = encodeJpeg(16, 16, () => [40, 120, 200, 255])
    const out = compressImage("image/jpeg", bytes, DEFAULT_MAX_IMAGE_BYTES)
    expect(out).toBeDefined()
    expect(out!.mediaType).toBe("image/jpeg")
    expect(base64Bytes(out!.data)).toBeLessThanOrEqual(DEFAULT_MAX_IMAGE_BYTES)
    const decoded = jpeg.decode(Buffer.from(out!.data, "base64"), { useTArray: true })
    // Dimensions preserved because it fit at the first (scale=1) rung.
    expect(decoded.width).toBe(16)
    expect(decoded.height).toBe(16)
  })

  test("small PNG round-trips to a decodable JPEG", () => {
    const bytes = encodePng(24, 24, (x, y) => [x * 10, y * 10, 100, 255])
    const out = compressImage("image/png", bytes, DEFAULT_MAX_IMAGE_BYTES)
    expect(out).toBeDefined()
    const decoded = jpeg.decode(Buffer.from(out!.data, "base64"), { useTArray: true })
    expect(decoded.width).toBe(24)
    expect(decoded.height).toBe(24)
  })
})

// --- compressImage: undecodable / failure paths -------------------------

describe("compressImage - undecodable formats return undefined", () => {
  test("webp mime (no pure-JS decoder) returns undefined", () => {
    // RIFF....WEBP header bytes; we have no webp decoder so this can't be shrunk.
    const fakeWebp = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ])
    expect(compressImage("image/webp", fakeWebp, DEFAULT_MAX_IMAGE_BYTES)).toBeUndefined()
  })

  test("gif mime returns undefined", () => {
    const fakeGif = Buffer.from("GIF89a", "ascii")
    expect(compressImage("image/gif", fakeGif, DEFAULT_MAX_IMAGE_BYTES)).toBeUndefined()
  })

  test("corrupt PNG bytes under a png mime return undefined (decode throws)", () => {
    const garbage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03, 0x04])
    expect(compressImage("image/png", garbage, DEFAULT_MAX_IMAGE_BYTES)).toBeUndefined()
  })

  test("empty buffer returns undefined", () => {
    expect(compressImage("image/png", Buffer.alloc(0), DEFAULT_MAX_IMAGE_BYTES)).toBeUndefined()
  })
})
