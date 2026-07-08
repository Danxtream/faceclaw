package com.faceclaw.app;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.util.Log;

import androidx.core.graphics.PathParser;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Renders a small subset of SVG (the shapes used by Lucide / simple Noun
 * Project icons: path, circle, ellipse, rect, line, polyline, polygon) to a
 * grayscale coverage buffer for use as an on-glasses icon. Icons are stroked
 * (Lucide style: fill="none", 2px stroke, round caps/joins); the returned
 * bytes are one coverage value per pixel (0=transparent .. 255=opaque white),
 * row-major, size*size. Called once per icon and cached on the TS side.
 */
public final class IconRenderer {
    private static final String TAG = "IconRenderer";
    private static final Pattern TAG_RE = Pattern.compile("<(path|circle|ellipse|rect|line|polyline|polygon)\\b([^>]*)>");
    private static final Pattern VIEWBOX_RE = Pattern.compile("viewBox\\s*=\\s*\"([^\"]*)\"");

    private IconRenderer() {}

    public static byte[] renderSvgGray(String svg, int size, float strokeWidth) {
        if (svg == null || size <= 0) {
            return new byte[0];
        }
        try {
            float minX = 0f, minY = 0f, viewW = 24f, viewH = 24f;
            Matcher vb = VIEWBOX_RE.matcher(svg);
            if (vb.find()) {
                String[] parts = vb.group(1).trim().split("[\\s,]+");
                if (parts.length == 4) {
                    minX = Float.parseFloat(parts[0]);
                    minY = Float.parseFloat(parts[1]);
                    viewW = Float.parseFloat(parts[2]);
                    viewH = Float.parseFloat(parts[3]);
                }
            }
            // Lucide-style icons are stroked outlines (fill="none"); everything
            // else (Noun Project glyphs, brand logos) is a filled shape.
            boolean stroked = svg.contains("fill=\"none\"");
            Path path = new Path();
            Matcher m = TAG_RE.matcher(svg);
            while (m.find()) {
                appendElement(path, m.group(1), m.group(2));
            }
            if (path.isEmpty()) {
                return new byte[0];
            }

            Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            float scale = Math.min(size / viewW, size / viewH);
            // Center the (square) viewBox in the bitmap, then map its origin.
            canvas.translate((size - viewW * scale) / 2f, (size - viewH * scale) / 2f);
            canvas.scale(scale, scale);
            canvas.translate(-minX, -minY);
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            paint.setColor(0xffffffff);
            if (stroked) {
                paint.setStyle(Paint.Style.STROKE);
                paint.setStrokeWidth(strokeWidth);
                paint.setStrokeCap(Paint.Cap.ROUND);
                paint.setStrokeJoin(Paint.Join.ROUND);
            } else {
                paint.setStyle(Paint.Style.FILL);
            }
            canvas.drawPath(path, paint);

            int[] pixels = new int[size * size];
            bitmap.getPixels(pixels, 0, size, 0, 0, size, size);
            byte[] gray = new byte[size * size];
            for (int i = 0; i < pixels.length; i++) {
                gray[i] = (byte) ((pixels[i] >>> 24) & 0xff); // alpha = coverage
            }
            return gray;
        } catch (Exception e) {
            Log.w(TAG, "icon render failed", e);
            return new byte[0];
        }
    }

    private static void appendElement(Path path, String tag, String attrs) {
        switch (tag) {
            case "path": {
                String d = attr(attrs, "d");
                if (d != null) {
                    Path sub = PathParser.createPathFromPathData(d);
                    if (sub != null) {
                        path.addPath(sub);
                    }
                }
                break;
            }
            case "circle": {
                float cx = num(attrs, "cx", 0), cy = num(attrs, "cy", 0), r = num(attrs, "r", 0);
                if (r > 0) path.addCircle(cx, cy, r, Path.Direction.CW);
                break;
            }
            case "ellipse": {
                float cx = num(attrs, "cx", 0), cy = num(attrs, "cy", 0);
                float rx = num(attrs, "rx", 0), ry = num(attrs, "ry", 0);
                if (rx > 0 && ry > 0) path.addOval(cx - rx, cy - ry, cx + rx, cy + ry, Path.Direction.CW);
                break;
            }
            case "rect": {
                float x = num(attrs, "x", 0), y = num(attrs, "y", 0);
                float w = num(attrs, "width", 0), h = num(attrs, "height", 0);
                float rx = num(attrs, "rx", 0), ry = num(attrs, "ry", rx > 0 ? rx : 0);
                if (rx <= 0) rx = ry;
                if (ry <= 0) ry = rx;
                if (w > 0 && h > 0) {
                    if (rx > 0 || ry > 0) {
                        path.addRoundRect(x, y, x + w, y + h, rx, ry, Path.Direction.CW);
                    } else {
                        path.addRect(x, y, x + w, y + h, Path.Direction.CW);
                    }
                }
                break;
            }
            case "line": {
                path.moveTo(num(attrs, "x1", 0), num(attrs, "y1", 0));
                path.lineTo(num(attrs, "x2", 0), num(attrs, "y2", 0));
                break;
            }
            case "polyline":
            case "polygon": {
                String points = attr(attrs, "points");
                if (points != null) {
                    String[] nums = points.trim().split("[\\s,]+");
                    boolean started = false;
                    for (int i = 0; i + 1 < nums.length; i += 2) {
                        float px = Float.parseFloat(nums[i]);
                        float py = Float.parseFloat(nums[i + 1]);
                        if (!started) {
                            path.moveTo(px, py);
                            started = true;
                        } else {
                            path.lineTo(px, py);
                        }
                    }
                    if (tag.equals("polygon")) path.close();
                }
                break;
            }
            default:
                break;
        }
    }

    private static String attr(String attrs, String name) {
        Matcher m = Pattern.compile("\\b" + name + "\\s*=\\s*\"([^\"]*)\"").matcher(attrs);
        return m.find() ? m.group(1) : null;
    }

    private static float num(String attrs, String name, float fallback) {
        String value = attr(attrs, name);
        if (value == null) return fallback;
        try {
            return Float.parseFloat(value.trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }
}
