/**
 * routes/userRoutes.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Route table for account management. There is deliberately no registration
 *   endpoint: an account can only be created by the role above it, through
 *   POST /api/users by an already signed-in admin or teacher.
 *
 *   GET    /api/users                     list (scoped to the caller)
 *   GET    /api/users/password-suggestion a generated password for the dialogs
 *   POST   /api/users                     create a teacher or a student
 *   DELETE /api/users/:id                 delete a user
 *   POST   /api/users/:id/password        reset someone else's password
 *
 *   The whole group requires a session and a role of admin or teacher; both
 *   are applied in app.js. The per-target decision happens underneath, in
 *   canAccess().
 */

import { Router } from 'express';
import * as userController from '../controllers/userController.js';

const router = Router();

// Declared before '/users/:id'-shaped paths so the literal segment is not
// swallowed by a parameter.
router.get('/users/password-suggestion', userController.suggestPassword);

router.get('/users', userController.listUsers);
router.post('/users', userController.createUser);
router.delete('/users/:id', userController.deleteUser);
router.post('/users/:id/password', userController.resetPassword);

export default router;
