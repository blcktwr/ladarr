import type { RenameCheck } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { exampleNames, templateProblem, type NamingTemplates } from '../../../library/naming.ts';
import { isObject } from '../../../helpers/rename.ts';

// The names of a sample movie and a sample episode, and the problem of each template.
export function renameExamples(): RequestHandler {
  return (req, res) => {
    const body = isObject(req.body) ? req.body : {};
    const problems = { movie: templateProblem('movie', body.movie), episode: templateProblem('episode', body.episode) };
    res.json({ problems, examples: problems.movie || problems.episode ? null : exampleNames(body as NamingTemplates) } satisfies RenameCheck);
  };
}
