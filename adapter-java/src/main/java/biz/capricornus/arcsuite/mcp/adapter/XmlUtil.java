package biz.capricornus.arcsuite.mcp.adapter;

import org.w3c.dom.*;
import org.xml.sax.InputSource;

import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.StringReader;
import java.util.ArrayList;
import java.util.List;

final class XmlUtil {
    private XmlUtil() {}

    static Document parse(byte[] xml) {
        try {
            var f = DocumentBuilderFactory.newInstance();
            f.setNamespaceAware(true);
            f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            f.setFeature("http://xml.org/sax/features/external-general-entities", false);
            f.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            f.setXIncludeAware(false);
            f.setExpandEntityReferences(false);
            try { f.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, ""); } catch (IllegalArgumentException ignored) {}
            try { f.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, ""); } catch (IllegalArgumentException ignored) {}
            return f.newDocumentBuilder().parse(new java.io.ByteArrayInputStream(xml));
        } catch (Exception e) {
            throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "Invalid XML returned by ArcSuite", false, null, e);
        }
    }

    static Document parse(String xml) {
        return parse(xml.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    static Element firstDesc(Element root, String localName) {
        var nodes = root.getElementsByTagNameNS("*", localName);
        return nodes.getLength() == 0 ? null : (Element) nodes.item(0);
    }

    static Element child(Element root, String localName) {
        for (Node n = root.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (n instanceof Element e && localName.equals(e.getLocalName())) return e;
        }
        return null;
    }

    static List<Element> children(Element root, String localName) {
        List<Element> out = new ArrayList<>();
        for (Node n = root.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (n instanceof Element e && localName.equals(e.getLocalName())) out.add(e);
        }
        return out;
    }

    static List<Element> descendants(Element root, String localName) {
        List<Element> out = new ArrayList<>();
        NodeList nodes = root.getElementsByTagNameNS("*", localName);
        for (int i=0;i<nodes.getLength();i++) out.add((Element)nodes.item(i));
        return out;
    }

    static String text(Element e) { return e == null ? null : e.getTextContent(); }
    static String childText(Element e, String name) { return text(child(e,name)); }
    static boolean bool(String s) { return s != null && Boolean.parseBoolean(s.trim()); }

    static String esc(String s) {
        if (s == null) return "";
        return s.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;").replace("\"","&quot;").replace("'","&apos;");
    }

    static String localType(Element e) {
        String x = e.getAttributeNS(XMLConstants.W3C_XML_SCHEMA_INSTANCE_NS_URI, "type");
        if (x == null || x.isBlank()) x = e.getAttribute("xsi:type");
        if (x == null) return "";
        int colon=x.indexOf(':'); return colon >= 0 ? x.substring(colon+1) : x;
    }
}
