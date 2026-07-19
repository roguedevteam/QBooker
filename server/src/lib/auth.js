import jwt from "jsonwebtoken";
import "dotenv/config";

const SECRET = process.env.JWT_SECRET;

export function signSession(payload, expiresIn = "12h") {
  return jwt.sign(payload, SECRET, { expiresIn });
}

export function requireAuth(...allowedRoles) {
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Not signed in." });
    try {
      const payload = jwt.verify(token, SECRET);
      if (allowedRoles.length && !allowedRoles.includes(payload.role)) {
        return res.status(403).json({ error: "Not allowed for this role." });
      }
      req.auth = payload;
      next();
    } catch (err) {
      return res.status(401).json({ error: "Session expired or invalid — please sign in again." });
    }
  };
}
