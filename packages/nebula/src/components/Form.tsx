import { Form as BaseForm } from '@base-ui/react/form';

type FormProps = Omit<BaseForm.Props, 'className'>;

// A form of fields, with space between them. It fills the width of its column, so a field can shrink to fit a narrow screen.
export function Form(props: FormProps) {
  return <BaseForm {...props} className="grid grid-cols-[minmax(0,1fr)] justify-items-start gap-5 w-full" />;
}
