/**
 * routes/authRoutes.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Route table for signing in and out.
 *
 *   POST /api/auth/login     sign in (public — the only unauthenticated
 *                            endpoint that touches user data)
 *   POST /api/auth/logout    sign out
 *   GET  /api/auth/me        who am I
 *   POST /api/auth/password  change my own password
 *
 *   The last three require a session. That is applied in app.js rather than
 *   here, so every protected path in the application is listed in one place
 *   and none can be forgotten by being added to a route file alone.
 */

import { Router } from 'express';
import * as authController from '../controllers/authController.js';

const router = Router();

router.post('/auth/login', authController.login);
router.post('/auth/logout', authController.logout);
router.get('/auth/me', authController.me);
router.post('/auth/password', authController.changePassword);

export default router;
