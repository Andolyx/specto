import tw, { styled } from "twin.macro";

const Wrapper = styled.svg`
  ${tw`block fill-current`}
`;

export interface WordmarkProps {
  className?: string;
}

function Wordmark(props: WordmarkProps) {
  return (
    <Wrapper className={props.className} viewBox="0 0 124 24" role="img" aria-label="Specto">
      <text
        x="0"
        y="22"
        fontFamily="'Noto Sans Display', sans-serif"
        fontSize="30"
        fontWeight="700"
        letterSpacing="1"
        textLength="124"
        lengthAdjust="spacingAndGlyphs"
      >
        SPECTO
      </text>
    </Wrapper>
  );
}

export default Wordmark;
