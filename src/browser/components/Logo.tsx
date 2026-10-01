import tw, { styled } from "twin.macro";

const Wrapper = styled.img`
  ${tw`block`}
`;

export interface LogoProps {
  className?: string;
}

function Logo(props: LogoProps) {
  return <Wrapper className={props.className} src={browser.runtime.getURL("logo.png")} alt="" />;
}

export default Logo;
