import { DrupalNode, DrupalTaxonomyTerm } from "next-drupal"
import { useTranslation } from "next-i18next"

import { Breadcrumbs } from "components/breadcrumbs"
import { PageHeader } from "components/page-header"
import { NodeRecipeTeaser } from "./node--recipe--teaser"

export interface TaxonomyTermRecipeCategoryProps {
  term: DrupalTaxonomyTerm
  additionalContent: {
    termContent: DrupalNode[]
  }
}

export function TaxonomyTermRecipeCategory({
  term,
  additionalContent,
}: TaxonomyTermRecipeCategoryProps) {
  const { t } = useTranslation()

  return (
    <div className="container">
      <Breadcrumbs
        items={[
          {
            title: t("home"),
            url: "/",
          },
          {
            title: term.name,
          },
        ]}
      />
      <PageHeader heading={term.name} />
      <div className="grid grid-cols-2 gap-8 lg:grid-cols-4">
        {additionalContent?.termContent.map((recipe) => (
          <NodeRecipeTeaser key={recipe.id} node={recipe} />
        ))}
      </div>
    </div>
  )
}
