/**
 * routes/computeRoutes.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Route table for the computation endpoints. Routes only map paths to
 *   controller functions — no logic lives here.
 *
 *   POST /api/validate   validate a grammar payload
 *   (POST /api/cnf and POST /api/cyk are registered in their own steps.)
 */

import { Router } from 'express';
import * as computeController from '../controllers/computeController.js';

const router = Router();

router.post('/validate', computeController.postValidate);

export default router;
