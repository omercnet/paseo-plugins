import { Text, type TextStyle } from "react-native";
import { splitHighlight } from "./highlight";

interface HighlightedTextProps {
  text: string;
  query: string;
  highlightStyle: TextStyle;
}

export function HighlightedText({ text, query, highlightStyle }: HighlightedTextProps) {
  let offset = 0;
  return (
    <>
      {splitHighlight(text, query).map((segment) => {
        const key = offset;
        offset += segment.text.length;
        return segment.match ? (
          <Text key={key} style={highlightStyle}>
            {segment.text}
          </Text>
        ) : (
          segment.text
        );
      })}
    </>
  );
}
