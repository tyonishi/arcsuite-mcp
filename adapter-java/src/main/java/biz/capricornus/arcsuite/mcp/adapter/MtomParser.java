package biz.capricornus.arcsuite.mcp.adapter;

import java.nio.charset.StandardCharsets;
import java.util.*;

record MtomMessage(byte[] rootXml, Map<String,byte[]> attachments) {}

final class MtomParser {
    private MtomParser() {}

    static MtomMessage parse(String contentType, byte[] body) {
        if (contentType == null || !contentType.toLowerCase(Locale.ROOT).startsWith("multipart/related")) {
            return new MtomMessage(body, Map.of());
        }
        String boundary = param(contentType, "boundary");
        if (boundary == null || boundary.isBlank()) throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "MTOM response missing boundary");
        byte[] marker = ("--" + boundary).getBytes(StandardCharsets.ISO_8859_1);
        List<Part> parts = split(body, marker);
        if (parts.isEmpty()) throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "MTOM response contains no parts");
        byte[] root = null;
        Map<String,byte[]> attachments = new HashMap<>();
        for (Part part : parts) {
            String cid = normalizeCid(part.headers.get("content-id"));
            String ct = part.headers.getOrDefault("content-type", "").toLowerCase(Locale.ROOT);
            if (root == null && (ct.contains("application/xop+xml") || ct.contains("text/xml") || ct.contains("application/soap+xml"))) root = part.data;
            else if (cid != null) attachments.put(cid, part.data);
        }
        if (root == null) root = parts.get(0).data;
        return new MtomMessage(root, attachments);
    }

    private record Part(Map<String,String> headers, byte[] data) {}

    private static List<Part> split(byte[] body, byte[] marker) {
        List<Part> out=new ArrayList<>();
        int first = boundaryAt(body, marker, 0);
        if (first != 0) throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "MTOM response has an invalid initial boundary");
        int cursor = marker.length;
        while (true) {
            if (startsWith(body, cursor, (byte) '-', (byte) '-')) break;
            if (!startsWith(body, cursor, (byte) '\r', (byte) '\n')) {
                throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "MTOM response boundary framing was invalid");
            }
            cursor += 2;
            int headerEnd = indexOf(body, "\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1), cursor);
            if (headerEnd < 0) throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "MTOM part headers were invalid");
            String hs = new String(body, cursor, headerEnd - cursor, StandardCharsets.ISO_8859_1);
            Map<String,String> headers = new HashMap<>();
            for (String line : hs.split("\\r\\n", -1)) {
                int colon = line.indexOf(':');
                if (colon <= 0) throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "MTOM part header was invalid");
                headers.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT), line.substring(colon + 1).trim());
            }
            int dataStart = headerEnd + 4;
            int next = boundaryAt(body, marker, dataStart);
            if (next < 0 || next < dataStart + 2) throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "MTOM response boundary was missing");
            // The CRLF immediately before a valid delimiter belongs to MIME
            // framing. Remove exactly that pair; all earlier payload bytes,
            // including payload CR/LF endings, are retained byte-for-byte.
            int dataEnd = next - 2;
            if (body[dataEnd] != '\r' || body[dataEnd + 1] != '\n') {
                throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "MTOM response boundary framing was invalid");
            }
            out.add(new Part(headers, Arrays.copyOfRange(body, dataStart, dataEnd)));
            cursor = next + marker.length;
        }
        if (!startsWith(body, cursor, (byte) '-', (byte) '-')) {
            throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "MTOM closing boundary was invalid");
        }
        cursor += 2;
        if (cursor < body.length && startsWith(body, cursor, (byte) '\r', (byte) '\n')) cursor += 2;
        for (int i = cursor; i < body.length; i++) {
            if (body[i] != '\r' && body[i] != '\n') throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "MTOM trailing bytes were invalid");
        }
        return out;
    }

    private static int boundaryAt(byte[] body, byte[] marker, int from) {
        int candidate = indexOf(body, marker, from);
        while (candidate >= 0) {
            boolean lineStart = candidate == 0 || (candidate >= 2 && body[candidate - 2] == '\r' && body[candidate - 1] == '\n');
            boolean delimiterEnd = startsWith(body, candidate + marker.length, (byte) '-', (byte) '-')
                    || startsWith(body, candidate + marker.length, (byte) '\r', (byte) '\n');
            if (lineStart && delimiterEnd) return candidate;
            candidate = indexOf(body, marker, candidate + 1);
        }
        return -1;
    }

    private static boolean startsWith(byte[] body, int offset, byte first, byte second) {
        return offset >= 0 && offset + 1 < body.length && body[offset] == first && body[offset + 1] == second;
    }

    private static int indexOf(byte[] hay, byte[] needle, int from){ outer:for(int i=Math.max(0,from);i<=hay.length-needle.length;i++){for(int j=0;j<needle.length;j++)if(hay[i+j]!=needle[j])continue outer;return i;}return -1;}
    private static String param(String ct,String name){ for(String p:ct.split(";")){int e=p.indexOf('=');if(e>0&&p.substring(0,e).trim().equalsIgnoreCase(name)){String v=p.substring(e+1).trim();if(v.startsWith("\"")&&v.endsWith("\"")&&v.length()>=2)v=v.substring(1,v.length()-1);return v;}}return null; }
    static String normalizeCid(String cid){ if(cid==null)return null; String x=cid.trim(); if(x.startsWith("<")&&x.endsWith(">"))x=x.substring(1,x.length()-1); if(x.startsWith("cid:"))x=x.substring(4);return x; }
}
