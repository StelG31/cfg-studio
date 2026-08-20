/**
 * routes/computeRoutes.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Route table for the computation endpoints. Routes only map paths to
 *   controller functions — no logic lives here.
 *
 *   POST /api/validate   validate a grammar payload
 *   POST /api/cnf        CNF conversion with the full step trace
 *   POST /api/cyk        run CYK over a grammar already in CNF
 *   POST /api/earley     run Earley over any valid grammar, no conversion
 *
 *   One endpoint per module in core/ that computes something: the API mirrors
 *   the shared core, not the frontend, which is why /api/earley exists even
 *   though the browser parses locally and never calls it.
 */

import { Router } from 'express';
import * as computeController from '../controllers/computeController.js';

const router = Router();

router.post('/validate', computeController.postValidate);
router.post('/cnf', computeController.postCnf);
router.post('/cyk', computeController.postCyk);
router.post('/earley', computeController.postEarley);

export default router;
