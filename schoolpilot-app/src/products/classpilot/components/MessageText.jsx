import { splitMessageLinks } from '../lib/messageLinks';

export default function MessageText({ text }) {
  return splitMessageLinks(text).map((part, index) => part.href ? (
    <a
      key={index}
      href={part.href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2 [overflow-wrap:anywhere] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
    >{part.text}</a>
  ) : part.text);
}
