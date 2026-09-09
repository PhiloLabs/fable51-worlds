import { boot, reportBootError } from './boot';
import { createDeathStar } from './world/deathstar';
import { createTrench } from './world/trench';
import { createXWing } from './craft/xwing';
import { createTIESquadron } from './craft/tie';

boot({ createXWing, createDeathStar, createTrench, createTIESquadron }).catch(reportBootError);
