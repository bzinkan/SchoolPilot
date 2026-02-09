import jwt from "jsonwebtoken";

const STUDENT_TOKEN_SECRET =
  process.env.STUDENT_TOKEN_SECRET || "schoolpilot-dev-student-token-secret-32";
const TOKEN_EXPIRY = "7d";

export interface StudentTokenPayload {
  studentId: string;
  deviceId: string;
  schoolId: string;
  studentEmail?: string;
  iat?: number;
  exp?: number;
}

export function createStudentToken(payload: {
  studentId: string;
  deviceId: string;
  schoolId: string;
  studentEmail?: string;
}): string {
  return jwt.sign(
    {
      studentId: payload.studentId,
      deviceId: payload.deviceId,
      schoolId: payload.schoolId,
      studentEmail: payload.studentEmail,
    },
    STUDENT_TOKEN_SECRET,
    { algorithm: "HS256", expiresIn: TOKEN_EXPIRY }
  );
}

export function verifyStudentToken(token: string): StudentTokenPayload {
  try {
    return jwt.verify(token, STUDENT_TOKEN_SECRET, {
      algorithms: ["HS256"],
    }) as StudentTokenPayload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new TokenExpiredError("Student token has expired");
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw new InvalidTokenError("Invalid student token");
    }
    throw error;
  }
}

export class TokenExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenExpiredError";
  }
}

export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTokenError";
  }
}
