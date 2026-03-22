import 'express';

declare module 'express-serve-static-core' {
  interface Request {
    user?: {
      userId: number;
      username: string;
      role: 'admin' | 'viewer';
    };
  }
}
