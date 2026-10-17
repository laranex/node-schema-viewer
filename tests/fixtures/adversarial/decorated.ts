// A TypeScript model with legacy decorators and decorator metadata, as TypeORM-style models are written.
const columns: string[] = [];

function Column(): PropertyDecorator {
    return (_target, key) => {
        columns.push(String(key));
    };
}

export class Team {
    @Column()
    id!: number;

    @Column()
    name!: string;
}

export const outcome = { columns, team: new Team() instanceof Team };
