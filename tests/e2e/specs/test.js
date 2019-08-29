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
      cy.request('PUT', '/api/config/master', { config: { path: '{{id}}' } });
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
    cy.location('pathname').should('match', /^\/compare\/master../);

    // Renders correct number of "added" rows
    cy.get('[data-test=sheet] tbody tr')
      .should('have.length', 10)
      .should('have.class', '-status-added');

    // Merges and redirects to base branch
    cy.get('[data-test=commit-form]').submit();
    cy.location('pathname').should('be', '/records/master');

    // Renders correct number of rows
    cy.get('[data-test=sheet] tbody tr')
      .should('have.length', 10)
      .should('not.have.class', '-status-added');
  })

  it('Supports nested branch names', function () {
    cy.request({
      method: 'POST',
      url: '/api/import/master?branch=proposal/alpha',
      body: this.sampleData,
      headers: { 'content-type': 'text/csv' },
    });
    cy.request({
      method: 'POST',
      url: '/api/import/proposal/alpha?branch=proposal/beta',
      body: this.sampleDataChanged,
      headers: { 'content-type': 'text/csv' },
    });

    cy.visit('/compare/proposal/alpha..proposal/beta');

    // Renders correct number of diff rows
    cy.get('[data-test=sheet] tbody tr')
      .should('have.length', 11);

    // Merges and redirects to base branch
    cy.get('[data-test=commit-form]').submit();
    cy.location('pathname').should('be', '/records/proposal/alpha');

    // Renders correct number of rows
    cy.get('[data-test=sheet] tbody tr')
      .should('have.length', 9)
      .should('not.have.class', '-status-added');
  })
})
