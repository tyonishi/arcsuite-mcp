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
        List<Part> out=new ArrayList<>(); int pos=0;
        while(true){ int start=indexOf(body,marker,pos); if(start<0)break; start+=marker.length;
            if(start+2<=body.length && body[start]=='-' && body[start+1]=='-') break;
            if(start+2<=body.length && body[start]=='\r'&&body[start+1]=='\n') start+=2;
            int next=indexOf(body,marker,start); if(next<0)break; int end=next;
            while(end>start && (body[end-1]=='\r'||body[end-1]=='\n')) end--;
            byte[] part=Arrays.copyOfRange(body,start,end); int sep=indexOf(part,"\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1),0);
            if(sep<0){pos=next;continue;} String hs=new String(part,0,sep,StandardCharsets.ISO_8859_1); Map<String,String> h=new HashMap<>();
            for(String line:hs.split("\\r\\n")){ int c=line.indexOf(':'); if(c>0) h.put(line.substring(0,c).trim().toLowerCase(Locale.ROOT),line.substring(c+1).trim()); }
            out.add(new Part(h,Arrays.copyOfRange(part,sep+4,part.length))); pos=next;
        }
        return out;
    }

    private static int indexOf(byte[] hay, byte[] needle, int from){ outer:for(int i=Math.max(0,from);i<=hay.length-needle.length;i++){for(int j=0;j<needle.length;j++)if(hay[i+j]!=needle[j])continue outer;return i;}return -1;}
    private static String param(String ct,String name){ for(String p:ct.split(";")){int e=p.indexOf('=');if(e>0&&p.substring(0,e).trim().equalsIgnoreCase(name)){String v=p.substring(e+1).trim();if(v.startsWith("\"")&&v.endsWith("\"")&&v.length()>=2)v=v.substring(1,v.length()-1);return v;}}return null; }
    static String normalizeCid(String cid){ if(cid==null)return null; String x=cid.trim(); if(x.startsWith("<")&&x.endsWith(">"))x=x.substring(1,x.length()-1); if(x.startsWith("cid:"))x=x.substring(4);return x; }
}
