/**
 * routes/grammarRoutes.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   Route table for grammar persistence and the built-in examples.
 *
 *   GET    /api/grammars       list saved grammars (metadata)
 *   POST   /api/grammars       create (server-side validation)
 *   GET    /api/grammars/:id   fetch one grammar
 *   PUT    /api/grammars/:id   update
 *   DELETE /api/grammars/:id   delete
 *   GET    /api/examples       built-in sample grammars
 */

import { Router } from 'express';
import * as grammarController from '../controllers/grammarController.js';

const router = Router();

router.get('/grammars', grammarController.listGrammars);
router.post('/grammars', grammarController.createGrammar);
router.get('/grammars/:id', grammarController.getGrammar);
router.put('/grammars/:id', grammarController.updateGrammar);
router.delete('/grammars/:id', grammarController.deleteGrammar);
router.get('/examples', grammarController.listExamples);

export default router;
