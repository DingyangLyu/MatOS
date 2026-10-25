import type {SkillSummary} from '../types';
import type {Locale} from './types';

// Scientific/user assets carry their own optional display metadata.
// This distribution does not ship the upstream design translation catalogue.
function localizedValue(locale:Locale,values:Record<string,string>|undefined):string|undefined {
 if(!values)return undefined;
 return values[locale] ?? (locale.startsWith('zh') ? values['zh-CN'] : undefined) ?? values.en;
}
const normalize=(text:string)=>text.replace(/\s+/g,' ').trim();
export function localizeSkillName(locale:Locale,skill:SkillSummary):string {
 return localizedValue(locale,skill.displayName) ?? skill.name;
}
export function localizeSkillPrompt(locale:Locale,skill:SkillSummary):string|undefined {
 return localizedValue(locale,skill.examplePromptI18n) ?? (skill.examplePrompt ? normalize(skill.examplePrompt):undefined);
}
export function localizeSkillDescription(locale:Locale,skill:SkillSummary):string {
 return localizedValue(locale,skill.descriptionI18n) ?? normalize(skill.description);
}
