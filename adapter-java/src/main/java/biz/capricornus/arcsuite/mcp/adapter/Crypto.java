package biz.capricornus.arcsuite.mcp.adapter;

import javax.crypto.Cipher;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.Key;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.spec.RSAPublicKeySpec;
import java.util.Base64;

final class Crypto {
    private static final String CREDENTIAL_TRANSFORMATION =
            "RSA/ECB/PKCS1Padding";

    private Crypto() {}

    static Cipher credentialCipher(int mode, Key key) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance(CREDENTIAL_TRANSFORMATION);
        cipher.init(mode, key);
        return cipher;
    }

    static String encryptCredential(String challenge, String password, String modulusB64, String exponentB64) {
        try {
            byte[] modulusBytes = Base64.getDecoder().decode(modulusB64);
            byte[] exponentBytes = Base64.getDecoder().decode(exponentB64);
            BigInteger modulus = new BigInteger(1, modulusBytes);
            BigInteger exponent = new BigInteger(1, exponentBytes);
            PublicKey key = KeyFactory.getInstance("RSA").generatePublic(new RSAPublicKeySpec(modulus, exponent));
            Cipher cipher = credentialCipher(Cipher.ENCRYPT_MODE, key);
            byte[] plain = (challenge + password).getBytes(StandardCharsets.UTF_8);
            return Base64.getEncoder().encodeToString(cipher.doFinal(plain));
        } catch (Exception e) {
            throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "Failed to construct encrypted ArcSuite credential", false, null, e);
        }
    }
}
