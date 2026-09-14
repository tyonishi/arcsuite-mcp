package biz.capricornus.arcsuite.mcp.adapter;

import java.util.*;

/** Small JSON codec for the adapter's private localhost HTTP API; no external dependency. */
final class Json {
    private Json() {}

    static Object parse(String text) {
        Parser p = new Parser(text);
        Object value = p.value();
        p.ws();
        if (!p.eof()) throw new IllegalArgumentException("Unexpected trailing JSON");
        return value;
    }

    @SuppressWarnings("unchecked")
    static Map<String,Object> object(Object value) {
        if (!(value instanceof Map<?,?> m)) throw new IllegalArgumentException("JSON object required");
        return (Map<String,Object>) m;
    }

    static String stringify(Object value) {
        StringBuilder out = new StringBuilder();
        write(out, value);
        return out.toString();
    }

    private static void write(StringBuilder out, Object value) {
        if (value == null) { out.append("null"); return; }
        if (value instanceof String s) { string(out, s); return; }
        if (value instanceof Boolean || value instanceof Number) { out.append(value); return; }
        if (value instanceof Map<?,?> m) {
            out.append('{'); boolean first = true;
            for (var e : m.entrySet()) {
                if (!first) out.append(','); first = false;
                string(out, String.valueOf(e.getKey())); out.append(':'); write(out, e.getValue());
            }
            out.append('}'); return;
        }
        if (value instanceof Iterable<?> it) {
            out.append('['); boolean first = true;
            for (Object x : it) { if (!first) out.append(','); first=false; write(out, x); }
            out.append(']'); return;
        }
        if (value.getClass().isArray()) {
            out.append('['); int n = java.lang.reflect.Array.getLength(value);
            for (int i=0;i<n;i++) { if (i>0) out.append(','); write(out, java.lang.reflect.Array.get(value,i)); }
            out.append(']'); return;
        }
        string(out, String.valueOf(value));
    }

    private static void string(StringBuilder out, String s) {
        out.append('"');
        for (int i=0;i<s.length();i++) {
            char c=s.charAt(i);
            switch(c) {
                case '"' -> out.append("\\\""); case '\\' -> out.append("\\\\"); case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f"); case '\n' -> out.append("\\n"); case '\r' -> out.append("\\r"); case '\t' -> out.append("\\t");
                default -> { if (c < 0x20) out.append(String.format("\\u%04x", (int)c)); else out.append(c); }
            }
        }
        out.append('"');
    }

    private static final class Parser {
        final String s; int i;
        Parser(String s) { this.s=s; }
        boolean eof(){ return i>=s.length(); }
        void ws(){ while(!eof() && Character.isWhitespace(s.charAt(i))) i++; }
        Object value(){ ws(); if(eof()) throw err("value"); char c=s.charAt(i);
            if(c=='{') return object(); if(c=='[') return array(); if(c=='"') return string();
            if(c=='t' && take("true")) return true; if(c=='f' && take("false")) return false; if(c=='n' && take("null")) return null;
            if(c=='-' || Character.isDigit(c)) return number(); throw err("value"); }
        Map<String,Object> object(){ expect('{'); LinkedHashMap<String,Object> m=new LinkedHashMap<>(); ws(); if(peek('}')){i++;return m;}
            while(true){ ws(); String k=string(); ws(); expect(':'); Object v=value(); m.put(k,v); ws(); if(peek('}')){i++;return m;} expect(','); } }
        List<Object> array(){ expect('['); ArrayList<Object> a=new ArrayList<>(); ws(); if(peek(']')){i++;return a;}
            while(true){ a.add(value()); ws(); if(peek(']')){i++;return a;} expect(','); } }
        String string(){ expect('"'); StringBuilder o=new StringBuilder(); while(!eof()){ char c=s.charAt(i++); if(c=='"') return o.toString();
            if(c=='\\'){ if(eof()) throw err("escape"); char e=s.charAt(i++); switch(e){case '"','\\','/'->o.append(e); case 'b'->o.append('\b'); case 'f'->o.append('\f'); case 'n'->o.append('\n'); case 'r'->o.append('\r'); case 't'->o.append('\t'); case 'u'->{ if(i+4>s.length()) throw err("unicode"); o.append((char)Integer.parseInt(s.substring(i,i+4),16)); i+=4;} default->throw err("escape"); }} else o.append(c); }
            throw err("string"); }
        Number number(){ int start=i; if(peek('-'))i++; while(!eof()&&Character.isDigit(s.charAt(i)))i++; boolean floating=false;
            if(peek('.')){floating=true;i++;while(!eof()&&Character.isDigit(s.charAt(i)))i++;} if(!eof()&&(s.charAt(i)=='e'||s.charAt(i)=='E')){floating=true;i++;if(!eof()&&(s.charAt(i)=='+'||s.charAt(i)=='-'))i++;while(!eof()&&Character.isDigit(s.charAt(i)))i++;}
            String n=s.substring(start,i);
            if (floating) return Double.valueOf(n);
            return Long.valueOf(n); }
        boolean take(String t){ if(s.startsWith(t,i)){i+=t.length();return true;}return false; }
        boolean peek(char c){ return !eof()&&s.charAt(i)==c; }
        void expect(char c){ ws(); if(eof()||s.charAt(i)!=c) throw err("'"+c+"'"); i++; }
        IllegalArgumentException err(String expected){ return new IllegalArgumentException("Invalid JSON near offset "+i+", expected "+expected); }
    }
}
