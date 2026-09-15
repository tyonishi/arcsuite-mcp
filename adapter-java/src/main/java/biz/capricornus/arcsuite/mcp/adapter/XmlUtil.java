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

    static boolean is(Element element, String namespace, String localName) {
        return element != null && localName.equals(element.getLocalName())
                && (namespace == null ? element.getNamespaceURI() == null : namespace.equals(element.getNamespaceURI()));
    }

    static Element firstDesc(Element root, String namespace, String localName) {
        var nodes = root.getElementsByTagNameNS(namespace, localName);
        return nodes.getLength() == 0 ? null : (Element) nodes.item(0);
    }

    static Element child(Element root, String namespace, String localName) {
        for (Node n = root.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (n instanceof Element e && is(e, namespace, localName)) return e;
        }
        return null;
    }

    static List<Element> children(Element root, String namespace, String localName) {
        List<Element> out = new ArrayList<>();
        for (Node n = root.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (n instanceof Element e && is(e, namespace, localName)) out.add(e);
        }
        return out;
    }

    static String text(Element e) { return e == null ? null : e.getTextContent(); }
    static String childText(Element e, String namespace, String name) { return text(child(e, namespace, name)); }
    static boolean bool(String s) { return s != null && Boolean.parseBoolean(s.trim()); }

    static String esc(String s) {
        if (s == null) return "";
        return s.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;").replace("\"","&quot;").replace("'","&apos;");
    }

    static String qualifiedType(Element e, String expectedNamespace) {
        String lexical = e.getAttributeNS(XMLConstants.W3C_XML_SCHEMA_INSTANCE_NS_URI, "type");
        if (lexical == null || lexical.isBlank()) lexical = e.getAttribute("xsi:type");
        if (lexical == null || lexical.isBlank()) return "";
        int colon = lexical.indexOf(':');
        String prefix = colon < 0 ? "" : lexical.substring(0, colon);
        String local = colon < 0 ? lexical : lexical.substring(colon + 1);
        String namespace = e.lookupNamespaceURI(prefix.isEmpty() ? null : prefix);
        if (!expectedNamespace.equals(namespace) || local.isBlank()) {
            throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "ArcSuite xsi:type namespace was not expected");
        }
        return local;
    }
}
