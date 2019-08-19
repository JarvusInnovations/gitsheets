const GIT_DIR = Cypress.env('gitDir');
const gitDirParent = GIT_DIR.replace(/\/.git$/, '');

describe('e2e', () => {
  before(() => {
    cy.fixture('sample_data.csv').as('sampleData');
    cy.fixture('sample_data_changed.csv').as('sampleDataChanged');
  });

  beforeEach(() => {
    const env = { GIT_DIR };
    cy.exec(`mkdir -p ${gitDirParent}`);
    cy.exec(`git init ${gitDirParent}`).then(() => {;
      cy.exec('git commit -m "init" --allow-empty', { env });
      cy.request('PUT', '/api/master', { config: { path: '{{id}}' } });
    });
  })

  afterEach(() => {
    cy.exec(`rm -rf ${GIT_DIR}`)
  })

  it('Import, compare, and merge', function () {
    cy.visit('/');

    cy.get('[data-test=upload-file]').upload({
      fileContent: this.sampleData,
      fileName: 'sample_data.csv',
      mimeType: 'text/csv',
    });
    cy.get('[data-test=upload-form]').submit();
    cy.location('pathname').should('match', /^\/master\/compare\//);

    // Renders correct number of "added" rows
    cy.get('[data-test=sheet] tbody tr')
      .should('have.length', 10)
      .should('have.class', '-status-added');

    // Merges and redirects to base branch
    cy.get('[data-test=commit-form]').submit();
    cy.location('pathname').should('be', '/master');

    // Renders correct number of rows
    cy.get('[data-test=sheet] tbody tr')
      .should('have.length', 10)
      .should('not.have.class', '-status-added');
  })
})
